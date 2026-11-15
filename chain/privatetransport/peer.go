package privatetransport

import (
	"context"
	"errors"
	"io"
	"net"
	"regexp"
	"strconv"
	"sync"
	"time"

	"golang.org/x/net/proxy"
)

var onionPeer = regexp.MustCompile(`^[a-z2-7]{56}\.onion$`)

// PeerTunnel carries only an authenticated Comet peer byte stream. It cannot
// receive wallet selections, select a different peer, resolve DNS or fall back
// to a direct connection. Comet's configured peer ID authenticates the remote.
func PeerTunnel(ctx context.Context, listen, socks, target string, maxConnections int) error {
	if err := validatePeerTunnel(listen, socks, target, maxConnections); err != nil {
		return err
	}
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	defer listener.Close()
	return servePeerTunnel(ctx, listener, socks, target, maxConnections)
}

func validatePeerTunnel(listen, socks, target string, max int) error {
	for _, address := range []string{listen, socks} {
		host, port, err := net.SplitHostPort(address)
		number, e := strconv.Atoi(port)
		ip := net.ParseIP(host)
		if err != nil || e != nil || number < 1 || number > 65535 || ip == nil || !ip.IsLoopback() {
			return errors.New("explicit loopback IP:port listener and SOCKS proxy required")
		}
	}
	host, port, err := net.SplitHostPort(target)
	number, e := strconv.Atoi(port)
	if err != nil || e != nil || number < 1 || number > 65535 || !onionPeer.MatchString(host) || max < 1 || max > 8 {
		return errors.New("fixed v3 onion peer and one to eight connections required")
	}
	return nil
}

func servePeerTunnel(ctx context.Context, listener net.Listener, socks, target string, max int) error {
	dialer, err := proxy.SOCKS5("tcp", socks, nil, &net.Dialer{Timeout: 20 * time.Second})
	if err != nil {
		return err
	}
	contextual, ok := dialer.(proxy.ContextDialer)
	if !ok {
		return errors.New("context-aware SOCKS5 dialer required")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			listener.Close()
		case <-done:
		}
	}()
	defer close(done)
	slots := make(chan struct{}, max)
	var connections sync.WaitGroup
	defer connections.Wait()
	for {
		local, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			cancel()
			return err
		}
		select {
		case slots <- struct{}{}:
		default:
			local.Close()
			continue
		}
		connections.Add(1)
		go func() {
			defer connections.Done()
			defer func() { <-slots }()
			defer local.Close()
			dialContext, dialCancel := context.WithTimeout(ctx, 20*time.Second)
			remote, err := contextual.DialContext(dialContext, "tcp", target)
			dialCancel()
			if err != nil {
				return
			}
			defer remote.Close()
			finished := make(chan struct{})
			go func() {
				select {
				case <-ctx.Done():
					local.Close()
					remote.Close()
				case <-finished:
				}
			}()
			defer close(finished)
			// Both directions have bounded idle deadlines; neither bytes nor peer
			// identifiers are logged. A lost Tor connection closes this stream.
			copied := make(chan struct{})
			go func() { io.Copy(activeConn{remote}, activeConn{local}); remote.Close(); local.Close(); close(copied) }()
			io.Copy(activeConn{local}, activeConn{remote})
			local.Close()
			remote.Close()
			<-copied
		}()
	}
}

type activeConn struct{ net.Conn }

func (c activeConn) Read(p []byte) (int, error) {
	c.SetReadDeadline(time.Now().Add(2 * time.Minute))
	return c.Conn.Read(p)
}
func (c activeConn) Write(p []byte) (int, error) {
	c.SetWriteDeadline(time.Now().Add(20 * time.Second))
	return c.Conn.Write(p)
}
