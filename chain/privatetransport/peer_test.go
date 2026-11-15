package privatetransport

import (
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestLocalStateEndpoint(t *testing.T) {
	for _, endpoint := range []string{"http://127.0.0.1:26657", "http://[::1]:26657/"} {
		if err := LocalStateEndpoint(endpoint, ""); err != nil {
			t.Fatal(err)
		}
	}
	for _, endpoint := range []string{"http://localhost:26657", "https://127.0.0.1", "http://192.0.2.1", "http://example.onion", "http://127.0.0.1/path", "http://user@127.0.0.1", "http://127.0.0.1?x=1"} {
		if LocalStateEndpoint(endpoint, "") == nil {
			t.Fatal("remote lookup accepted", endpoint)
		}
	}
	if LocalStateEndpoint("http://127.0.0.1:26657", "127.0.0.1:9050") == nil {
		t.Fatal("proxied selection accepted")
	}
}
func TestPeerTunnelConfiguration(t *testing.T) {
	onion := strings.Repeat("a", 56) + ".onion:26656"
	if err := validatePeerTunnel("127.0.0.1:27666", "127.0.0.1:9050", onion, 4); err != nil {
		t.Fatal(err)
	}
	for _, row := range [][3]string{{"0.0.0.0:27666", "127.0.0.1:9050", onion}, {"127.0.0.1:27666", "localhost:9050", onion}, {"127.0.0.1:27666", "192.0.2.1:9050", onion}, {"127.0.0.1:27666", "127.0.0.1:9050", "192.0.2.1:26656"}, {"127.0.0.1:27666", "127.0.0.1:9050", "short.onion:26656"}, {"127.0.0.1:0", "127.0.0.1:9050", onion}} {
		if validatePeerTunnel(row[0], row[1], row[2], 4) == nil {
			t.Fatal("unsafe tunnel accepted", row)
		}
	}
	if validatePeerTunnel("127.0.0.1:27666", "127.0.0.1:9050", onion, 9) == nil {
		t.Fatal("unbounded connections")
	}
}
func TestPeerTunnelRemoteDNSDuplexAndCancellation(t *testing.T) {
	socks, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socks.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- servePeerTunnel(ctx, listener, socks.Addr().String(), strings.Repeat("a", 56)+".onion:26656", 1)
	}()
	remoteResult := make(chan error, 1)
	go func() {
		conn, e := socks.Accept()
		if e != nil {
			remoteResult <- e
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(5 * time.Second))
		greeting := make([]byte, 3)
		if _, e = io.ReadFull(conn, greeting); e != nil {
			remoteResult <- e
			return
		}
		conn.Write([]byte{5, 0})
		header := make([]byte, 5)
		if _, e = io.ReadFull(conn, header); e != nil {
			remoteResult <- e
			return
		}
		if header[3] != 3 {
			remoteResult <- io.ErrUnexpectedEOF
			return
		}
		address := make([]byte, int(header[4])+2)
		if _, e = io.ReadFull(conn, address); e != nil {
			remoteResult <- e
			return
		}
		if string(address[:len(address)-2]) != strings.Repeat("a", 56)+".onion" || address[len(address)-2] != 104 || address[len(address)-1] != 32 {
			remoteResult <- io.ErrUnexpectedEOF
			return
		}
		conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 1})
		conn.Write([]byte("public blocks"))
		bytes := make([]byte, len("peer handshake"))
		_, e = io.ReadFull(conn, bytes)
		if e == nil && string(bytes) != "peer handshake" {
			e = io.ErrUnexpectedEOF
		}
		remoteResult <- e
		io.Copy(io.Discard, conn)
	}()
	local, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	local.SetDeadline(time.Now().Add(5 * time.Second))
	local.Write([]byte("peer handshake"))
	bytes := make([]byte, len("public blocks"))
	if _, err = io.ReadFull(local, bytes); err != nil || string(bytes) != "public blocks" {
		t.Fatal("duplex stream", string(bytes), err)
	}
	if err = <-remoteResult; err != nil {
		t.Fatal(err)
	}
	// Saturating the one-stream budget closes the new local connection rather
	// than dialing another remote. Cancellation also terminates the active stream.
	extra, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer extra.Close()
	extra.SetReadDeadline(time.Now().Add(time.Second))
	if n, e := extra.Read(make([]byte, 1)); n != 0 || e == nil {
		t.Fatal("connection budget not enforced")
	}
	cancel()
	select {
	case err = <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("tunnel did not stop")
	}
	if n, e := local.Read(make([]byte, 1)); n != 0 || e == nil {
		t.Fatal("cancelled stream remained open")
	}
}
