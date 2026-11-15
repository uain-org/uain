// uain-private-state obtains proof-verified policy, licences and wallet notes.
// Party selection arrives on private stdin, never in public request URLs or
// command-line arguments. It reads no spending/member signing keys.
//
// By default it reads only the holder's own loopback full node. With
// --remote-verified (light mode) it reads any untrusted node: every
// selection-dependent key is answered from complete proven prefix scans
// (privatewallet.Oblivious), and every value is verified against the pinned
// genesis exactly as in the default mode.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmtbytes "github.com/cometbft/cometbft/libs/bytes"
	cmtjson "github.com/cometbft/cometbft/libs/json"
	rpcclient "github.com/cometbft/cometbft/rpc/client"
	rpchttp "github.com/cometbft/cometbft/rpc/client/http"
	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/uain-org/uain/chain/privatetransport"
	"github.com/uain-org/uain/chain/privatewallet"
	"github.com/uain-org/uain/chain/proof"
)

type source struct{ client *rpchttp.HTTP }

type transitionSource struct {
	source
	*rpchttp.HTTP
}

func (t transitionSource) Query(ctx context.Context, path string, data []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	return t.source.Query(ctx, path, data, height, prove)
}

func (s source) Query(ctx context.Context, path string, data []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	result, err := privatetransport.RetryRead(ctx, func() (*coretypes.ResultABCIQuery, error) {
		return s.client.ABCIQueryWithOptions(ctx, path, cmtbytes.HexBytes(data), rpcclient.ABCIQueryOptions{Height: height, Prove: prove})
	})
	if err != nil {
		return abci.ResponseQuery{}, err
	}
	if result == nil {
		return abci.ResponseQuery{}, errors.New("missing query response")
	}
	return result.Response, nil
}

type cappedTransport struct{ http.RoundTripper }
type limitedBody struct {
	io.Reader
	io.Closer
}

func (t cappedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	response, err := t.RoundTripper.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	response.Body = limitedBody{Reader: io.LimitReader(response.Body, 2*1024*1024+1), Closer: response.Body}
	return response, nil
}
func main() {
	genesis := flag.String("genesis", "", "independently obtained public genesis file")
	pin := flag.String("genesis-sha256", "", "independent exact genesis SHA-256 pin")
	endpoint := flag.String("rpc", "", "private read-only RPC endpoint")
	output := flag.String("out", "", "new mode-600 private snapshot file")
	maxAge := flag.Duration("max-age", 10*time.Minute, "maximum age of finalized header, at most ten minutes")
	socks := flag.String("socks-proxy", "", "explicit loopback SOCKS5 proxy; required for onion RPC")
	method := flag.String("rpc-method", "", "public broadcast_tx_sync, without a private state snapshot")
	remote := flag.Bool("remote-verified", false, "light mode: read an untrusted remote node through complete proven prefix scans")
	flag.Parse()
	if err := run(*genesis, *pin, *endpoint, *output, *maxAge, *socks, *method, *remote); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(genesisPath, pin, endpoint, output string, maxAge time.Duration, socks, method string, remote bool) error {
	if len(pin) != 64 || output == "" || maxAge <= 0 || maxAge > 10*time.Minute {
		return errors.New("exact genesis pin, new output and bounded freshness required")
	}
	if method == "" && remote {
		if err := privatetransport.RemoteVerifiedEndpoint(endpoint, socks); err != nil {
			return err
		}
	} else if method == "" {
		if err := privatetransport.LocalStateEndpoint(endpoint, socks); err != nil {
			return err
		}
	}
	httpClient, err := privatetransport.Client(endpoint, socks)
	if err != nil {
		return err
	}
	httpClient.Transport = cappedTransport{RoundTripper: httpClient.Transport}
	f, err := os.Open(genesisPath)
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(f, 1024*1024+1))
	f.Close()
	if err != nil || len(raw) > 1024*1024 {
		return errors.New("invalid or oversized public genesis")
	}
	actual := sha256.Sum256(raw)
	if hex.EncodeToString(actual[:]) != pin {
		return errors.New("public genesis does not match independent pin")
	}
	var genesis cmttypes.GenesisDoc
	if err = cmtjson.Unmarshal(raw, &genesis); err != nil {
		return err
	}
	requestRaw, err := io.ReadAll(io.LimitReader(os.Stdin, 65537))
	if err != nil || len(requestRaw) > 65536 {
		return errors.New("oversized private state request")
	}
	if method != "" {
		if method != "broadcast_tx_sync" {
			return errors.New("only public synchronous broadcast is supported")
		}
		var params struct {
			Tx string `json:"tx"`
		}
		decoder := json.NewDecoder(bytes.NewReader(requestRaw))
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&params); err != nil || decoder.Decode(new(any)) != io.EOF || len(params.Tx) == 0 || len(params.Tx) > 43692 {
			return errors.New("bounded public transaction required")
		}
		client, e := rpchttp.NewWithClient(endpoint, "/websocket", httpClient)
		if e != nil {
			return e
		}
		tx, e := base64.StdEncoding.Strict().DecodeString(params.Tx)
		if e != nil || len(tx) > 32768 || base64.StdEncoding.EncodeToString(tx) != params.Tx {
			return errors.New("canonical bounded transaction required")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		result, e := client.BroadcastTxSync(ctx, tx)
		if e != nil {
			return e
		}
		encoded, e := cmtjson.Marshal(result)
		if e != nil || len(encoded) > 128*1024 {
			return errors.New("invalid broadcast response")
		}
		return writeOutput(output, encoded)
	}
	var request privatewallet.Request
	decoder := json.NewDecoder(bytes.NewReader(requestRaw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&request); err != nil {
		return err
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return errors.New("exactly one private state request required")
	}
	client, err := rpchttp.NewWithClient(endpoint, "/websocket", httpClient)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	commit, err := privatetransport.RetryRead(ctx, func() (*coretypes.ResultCommit, error) { return client.Commit(ctx, nil) })
	if err != nil {
		return err
	}
	if commit == nil {
		return errors.New("missing finalized header")
	}
	var reader privatewallet.Source = source{client: client}
	if remote {
		reader = privatewallet.NewOblivious(reader)
	} else if request.LightScan {
		return errors.New("a light scan requires --remote-verified")
	}
	// Follow signed validator-set changes from the pinned genesis.
	transitions, err := proof.FetchTransitions(ctx, transitionSource{source{client: client}, client}, commit.Height-1)
	if err != nil {
		return err
	}
	trusted, err := proof.Advance(&genesis, transitions)
	if err != nil {
		return err
	}
	state, err := privatewallet.Read(ctx, trusted, commit.SignedHeader, reader, time.Now().UTC(), maxAge, request)
	if err != nil {
		return err
	}
	if time.Since(state.HeaderTime) > maxAge {
		return errors.New("snapshot became stale during retrieval; retry with a recent finalized header")
	}
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err = writeOutput(output, encoded); err != nil {
		return err
	}
	if state.Light != nil {
		fmt.Printf("PRIVATE_STATE_VERIFIED height=%d notes=%d records=%d nullifiers=%d remote_pages=%d remote_proven_keys=%d\n", state.Height, state.Count, len(state.Records), len(state.Nullifiers), state.Light.Pages, state.Light.ProvenKeys)
		return nil
	}
	fmt.Printf("PRIVATE_STATE_VERIFIED height=%d notes=%d\n", state.Height, state.Count)
	return nil
}

func writeOutput(output string, encoded []byte) error {
	target, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	complete := false
	defer func() {
		target.Close()
		if !complete {
			os.Remove(output)
		}
	}()
	if _, err = target.Write(append(encoded, '\n')); err != nil {
		return err
	}
	if err = target.Sync(); err != nil {
		return err
	}
	if err = target.Close(); err != nil {
		return err
	}
	complete = true
	return nil
}
