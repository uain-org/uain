// Single loopback tunnel probe. Only SecretConnection authentication and the
// bounded CometBFT NodeInfo exchange are sent. No TX/application messages,
// validator/member/wallet keys, key files, retries, or network discovery.
package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"regexp"
	"time"

	"github.com/cometbft/cometbft/crypto/ed25519"
	"github.com/cometbft/cometbft/libs/protoio"
	"github.com/cometbft/cometbft/p2p"
	"github.com/cometbft/cometbft/p2p/conn"
	pb "github.com/cometbft/cometbft/proto/tendermint/p2p"
	"github.com/cometbft/cometbft/version"
)

const relayProbeTarget = "127.0.0.1:28666"
const relayProbeNetwork = "uain-shadow-20261008-1"
const forbiddenOfficialPeer = "6f019abdf01b330533178b3d10a587cdaf26c5b2"
const blockSyncChannel = byte(0x40)

var peerIDPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)

func validateNewPeer(id string) error {
	if !peerIDPattern.MatchString(id) || id == forbiddenOfficialPeer {
		return errors.New("a separately approved NEW relay peer ID is required")
	}
	return nil
}
func nodeID(key []byte) string { return hex.EncodeToString(key) }
func localProbeInfo(id p2p.ID, network string) p2p.DefaultNodeInfo {
	return p2p.DefaultNodeInfo{ProtocolVersion: p2p.NewProtocolVersion(version.P2PProtocol, version.BlockProtocol, 0), DefaultNodeID: id, ListenAddr: "127.0.0.1:28667", Network: network, Version: "0.40.0", Channels: []byte{blockSyncChannel}, Moniker: "baink-single-authenticated-handshake", Other: p2p.DefaultNodeInfoOther{TxIndex: "off", RPCAddress: ""}}
}
func exchangeProbeInfo(c net.Conn, ours p2p.DefaultNodeInfo) (p2p.DefaultNodeInfo, error) {
	var encoded pb.DefaultNodeInfo
	errs := make(chan error, 2)
	go func() { _, err := protoio.NewDelimitedWriter(c).WriteMsg(ours.ToProto()); errs <- err }()
	go func() { _, err := protoio.NewDelimitedReader(c, p2p.MaxNodeInfoSize()).ReadMsg(&encoded); errs <- err }()
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			return p2p.DefaultNodeInfo{}, err
		}
	}
	return p2p.DefaultNodeInfoFromToProto(&encoded)
}

type relayProbeResult struct {
	Schema                  string `json:"schema"`
	Target                  string `json:"target"`
	PeerID                  string `json:"authenticatedPeerId"`
	Network                 string `json:"network"`
	P2P                     uint64 `json:"p2pProtocol"`
	Block                   uint64 `json:"blockProtocol"`
	App                     uint64 `json:"appProtocol"`
	Channels                string `json:"channelsHex"`
	Connections             int    `json:"connections"`
	HeldMilliseconds        int64  `json:"heldMilliseconds"`
	ApplicationMessagesSent int    `json:"applicationMessagesSent"`
	TransactionsSent        int    `json:"transactionsSent"`
	PrivateKeyFilesRead     int    `json:"privateKeyFilesRead"`
}

// Read only a bounded amount of unsolicited encrypted peer traffic so an early
// FIN/error cannot be misreported as a successful 3-second connection hold.
func holdAuthenticatedRelay(c net.Conn, hold time.Duration) error {
	if hold == 0 {
		return nil
	}
	if err := c.SetDeadline(time.Now().Add(hold)); err != nil {
		return err
	}
	buffer := make([]byte, 4096)
	total := 0
	for {
		n, err := c.Read(buffer)
		total += n
		if total > 65536 {
			return errors.New("unsolicited peer traffic bound exceeded")
		}
		if err != nil {
			if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				return nil
			}
			return fmt.Errorf("peer closed before hold completed: %w", err)
		}
	}
}

// Tests may supply an isolated loopback port/network and a short hold. The CLI
// below always uses the one fixed tunnel port, production network and 3s hold.
func authenticateRelayOnce(target, expectedID, network string, hold time.Duration) (relayProbeResult, error) {
	var result relayProbeResult
	if err := validateNewPeer(expectedID); err != nil {
		return result, err
	}
	host, _, err := net.SplitHostPort(target)
	if err != nil || host != "127.0.0.1" || hold < 0 || hold > 3*time.Second {
		return result, errors.New("bounded literal loopback target required")
	}
	raw, err := net.DialTimeout("tcp", target, 10*time.Second)
	if err != nil {
		return result, err
	}
	defer raw.Close()
	if err = raw.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return result, err
	}
	ephemeral := ed25519.GenPrivKey() // RAM only; never persisted or printed.
	secured, err := conn.MakeSecretConnection(raw, ephemeral)
	if err != nil {
		return result, fmt.Errorf("secret connection: %w", err)
	}
	authenticated := nodeID(secured.RemotePubKey().Address())
	if authenticated != expectedID {
		return result, errors.New("authenticated NEW relay ID mismatch")
	}
	ours := localProbeInfo(p2p.ID(nodeID(ephemeral.PubKey().Address())), network)
	remote, err := exchangeProbeInfo(secured, ours)
	if err != nil {
		return result, fmt.Errorf("node info: %w", err)
	}
	if err = remote.Validate(); err != nil {
		return result, fmt.Errorf("invalid node info: %w", err)
	}
	if string(remote.ID()) != authenticated || remote.Network != network || remote.ProtocolVersion.P2P != version.P2PProtocol || remote.ProtocolVersion.Block != version.BlockProtocol || !remote.HasChannel(blockSyncChannel) {
		return result, errors.New("authenticated node ID/network/protocol/channels refused")
	}
	if err = ours.CompatibleWith(remote); err != nil {
		return result, err
	}
	// No MConnection, Switch, reactor, broadcast, application write, or retry.
	// The authenticated socket is held briefly and then closed by defer.
	started := time.Now()
	if err = holdAuthenticatedRelay(secured, hold); err != nil {
		return result, err
	}
	return relayProbeResult{Schema: "baink-single-public-relay-handshake-v1", Target: target, PeerID: authenticated, Network: remote.Network, P2P: remote.ProtocolVersion.P2P, Block: remote.ProtocolVersion.Block, App: remote.ProtocolVersion.App, Channels: hex.EncodeToString(remote.Channels), Connections: 1, HeldMilliseconds: time.Since(started).Milliseconds()}, nil
}
func main() {
	expected := flag.String("expected-new-peer-id", "", "root-approved NEW relay ID, never the official upstream")
	flag.Parse()
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "No additional targets or arguments allowed")
		os.Exit(2)
	}
	result, err := authenticateRelayOnce(relayProbeTarget, *expected, relayProbeNetwork, 3*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Single relay handshake refused:", err)
		os.Exit(1)
	}
	if err = json.NewEncoder(os.Stdout).Encode(result); err != nil {
		os.Exit(1)
	}
}
