package main

import (
	"github.com/cometbft/cometbft/crypto/ed25519"
	"github.com/cometbft/cometbft/p2p"
	"github.com/cometbft/cometbft/p2p/conn"
	"net"
	"testing"
	"time"
)

func fixtureRelay(t *testing.T, change func(*p2p.DefaultNodeInfo)) (string, string, <-chan int) {
	return fixtureRelayClosing(t, change, false)
}
func fixtureRelayClosing(t *testing.T, change func(*p2p.DefaultNodeInfo), early bool) (string, string, <-chan int) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	key := ed25519.GenPrivKey()
	id := nodeID(key.PubKey().Address())
	done := make(chan int, 1)
	go func() {
		defer listener.Close()
		raw, err := listener.Accept()
		if err != nil {
			done <- 0
			return
		}
		defer raw.Close()
		raw.SetDeadline(time.Now().Add(5 * time.Second))
		secured, err := conn.MakeSecretConnection(raw, key)
		if err != nil {
			done <- 0
			return
		}
		info := localProbeInfo(p2p.ID(id), "baink-fictional-authenticated-peer-v1")
		if change != nil {
			change(&info)
		}
		_, err = exchangeProbeInfo(secured, info)
		if err != nil {
			done <- 0
			return
		}
		if early {
			done <- 0
			return
		}
		buffer := make([]byte, 8)
		n, _ := secured.Read(buffer)
		done <- n
	}()
	return listener.Addr().String(), id, done
}
func TestSingleAuthenticatedLoopbackHandshakeNoApplicationWrite(t *testing.T) {
	address, id, done := fixtureRelay(t, nil)
	r, err := authenticateRelayOnce(address, id, "baink-fictional-authenticated-peer-v1", 10*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if r.PeerID != id || r.Connections != 1 || r.ApplicationMessagesSent != 0 || r.TransactionsSent != 0 || r.PrivateKeyFilesRead != 0 {
		t.Fatalf("unexpected projection: %+v", r)
	}
	if n := <-done; n != 0 {
		t.Fatalf("sent %d application bytes", n)
	}
}
func TestExpectedAuthAndReportedIdentityNetworkProtocolChannels(t *testing.T) {
	cases := []struct {
		name          string
		change        func(*p2p.DefaultNodeInfo)
		wrongExpected bool
	}{
		{"authenticated key", nil, true},
		{"reported ID", func(i *p2p.DefaultNodeInfo) { i.DefaultNodeID = p2p.ID("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") }, false},
		{"network", func(i *p2p.DefaultNodeInfo) { i.Network = "wrong-network" }, false},
		{"protocol", func(i *p2p.DefaultNodeInfo) { i.ProtocolVersion.Block++ }, false},
		{"channels", func(i *p2p.DefaultNodeInfo) { i.Channels = []byte{0x31} }, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			address, id, done := fixtureRelay(t, c.change)
			if c.wrongExpected {
				id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
			}
			if _, err := authenticateRelayOnce(address, id, "baink-fictional-authenticated-peer-v1", 0); err == nil {
				t.Fatal("accepted changed authenticated binding")
			}
			<-done
		})
	}
}
func TestNoOfficialPeerOrExternalTarget(t *testing.T) {
	for _, id := range []string{forbiddenOfficialPeer, "", "not-a-peer", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} {
		if err := validateNewPeer(id); err == nil {
			t.Fatal("accepted forbidden identity")
		}
	}
	for _, target := range []string{"example.com:28666", "127.0.0.2:28666", "[::1]:28666", "127.0.0.1"} {
		if _, err := authenticateRelayOnce(target, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", relayProbeNetwork, 0); err == nil {
			t.Fatal("accepted nonliteral-loopback target")
		}
	}
}

func TestEarlyDisconnectDoesNotClaimSuccessfulHold(t *testing.T) {
	address, id, done := fixtureRelayClosing(t, nil, true)
	if _, err := authenticateRelayOnce(address, id, "baink-fictional-authenticated-peer-v1", 20*time.Millisecond); err == nil {
		t.Fatal("early EOF accepted as completed hold")
	}
	<-done
}
