// uain-state verifies recent public federation state. Signing keys never enter
// this process; input is a bounded public record/member selection on stdin.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtbytes "github.com/cometbft/cometbft/libs/bytes"
	cmtjson "github.com/cometbft/cometbft/libs/json"
	rpcclient "github.com/cometbft/cometbft/rpc/client"
	rpchttp "github.com/cometbft/cometbft/rpc/client/http"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/uain-org/uain/chain/gateway"
	"github.com/uain-org/uain/chain/proof"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type source struct{ client *rpchttp.HTTP }

func (s source) Query(ctx context.Context, path string, key []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	q, e := s.client.ABCIQueryWithOptions(ctx, path, cmtbytes.HexBytes(key), rpcclient.ABCIQueryOptions{Height: height, Prove: prove})
	if e != nil {
		return abci.ResponseQuery{}, e
	}
	if q == nil {
		return abci.ResponseQuery{}, errors.New("missing finalized query")
	}
	return q.Response, nil
}

type transitionSource struct {
	source
	*rpchttp.HTTP
}

func (t transitionSource) Query(ctx context.Context, path string, key []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	return t.source.Query(ctx, path, key, height, prove)
}

type cappedTransport struct{ http.RoundTripper }
type limitedBody struct {
	io.Reader
	io.Closer
}

func (t cappedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	out, e := t.RoundTripper.RoundTrip(r)
	if e != nil {
		return nil, e
	}
	out.Body = limitedBody{io.LimitReader(out.Body, 2*1024*1024+1), out.Body}
	return out, nil
}
func main() {
	genesis := flag.String("genesis", "", "independently obtained genesis")
	pin := flag.String("genesis-sha256", "", "independent exact genesis pin")
	rpc := flag.String("rpc", "", "public finalized RPC endpoint")
	out := flag.String("out", "", "new mode-600 snapshot file")
	age := flag.Duration("max-age", 2*time.Minute, "maximum signed header age")
	flag.Parse()
	if e := run(*genesis, *pin, *rpc, *out, *age); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run(genesisPath, pin, endpoint, output string, age time.Duration) error {
	u, e := url.Parse(endpoint)
	if e != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || u.Scheme != "https" && (u.Scheme != "http" || u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") {
		return errors.New("HTTPS or member-owned loopback RPC required")
	}
	if len(pin) != 64 || output == "" || age <= 0 || age > 10*time.Minute {
		return errors.New("exact genesis pin, new output and bounded freshness required")
	}
	f, e := os.Open(genesisPath)
	if e != nil {
		return e
	}
	raw, e := io.ReadAll(io.LimitReader(f, 8*1024*1024+1))
	f.Close()
	if e != nil || len(raw) > 8*1024*1024 {
		return errors.New("invalid genesis size")
	}
	hash := sha256.Sum256(raw)
	if hex.EncodeToString(hash[:]) != pin {
		return errors.New("public genesis differs from independent pin")
	}
	var g cmttypes.GenesisDoc
	if e = cmtjson.Unmarshal(raw, &g); e != nil {
		return e
	}
	input, e := io.ReadAll(io.LimitReader(os.Stdin, 65537))
	if e != nil || len(input) > 65536 {
		return errors.New("bounded state selection required")
	}
	var request gateway.Request
	d := json.NewDecoder(bytes.NewReader(input))
	d.DisallowUnknownFields()
	if e = d.Decode(&request); e != nil || d.Decode(new(any)) != io.EOF {
		return errors.New("exactly one public state selection required")
	}
	client, e := rpchttp.NewWithClient(strings.TrimSuffix(endpoint, "/"), "/websocket", &http.Client{Timeout: 10 * time.Second, Transport: cappedTransport{http.DefaultTransport}})
	if e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	commit, e := client.Commit(ctx, nil)
	if e != nil {
		return e
	}
	if commit == nil {
		return errors.New("missing signed finalized header")
	}
	// Follow signed validator-set changes from the pinned genesis.
	transitions, e := proof.FetchTransitions(ctx, transitionSource{source{client}, client}, commit.Height-1)
	if e != nil {
		return e
	}
	trusted, e := proof.Advance(&g, transitions)
	if e != nil {
		return e
	}
	snapshot, e := gateway.Read(ctx, trusted, commit.SignedHeader, source{client}, time.Now().UTC(), age, request)
	if e != nil {
		return e
	}
	if time.Since(snapshot.HeaderTime) > age {
		return errors.New("snapshot expired during retrieval")
	}
	encoded, e := cmtjson.Marshal(snapshot)
	if e != nil {
		return e
	}
	file, e := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, e = file.Write(encoded)
	closeErr := file.Close()
	if e != nil {
		return e
	}
	return closeErr
}
