// Package privatetransport keeps onion RPC traffic on an explicit local SOCKS5
// connection. Domain names are passed to the proxy, never resolved locally.
package privatetransport

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"

	"golang.org/x/net/proxy"
)

// RetryRead retries only bounded transient failures of an explicitly read-only
// operation. Never use this for broadcast/signing or any consensus write.
func RetryRead[T any](ctx context.Context, read func() (T, error)) (T, error) {
	var result T
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		result, err = read()
		if err == nil {
			return result, nil
		}
		var network net.Error
		transient := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) || errors.As(err, &network) && network.Timeout()
		if !transient || attempt == 2 || ctx.Err() != nil {
			return result, err
		}
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return result, err
}

func Client(endpoint, socks string) (*http.Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("HTTP(S) root RPC endpoint without credentials/query required")
	}
	onion := strings.HasSuffix(strings.ToLower(u.Hostname()), ".onion")
	if onion && socks == "" {
		return nil, errors.New("onion RPC requires an explicit local SOCKS5 proxy")
	}
	transport := &http.Transport{Proxy: nil, MaxIdleConns: 4, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 15 * time.Second}
	if socks != "" {
		host, port, e := net.SplitHostPort(socks)
		ip := net.ParseIP(host)
		if e != nil || ip == nil || !ip.IsLoopback() || port == "" {
			return nil, errors.New("explicit loopback IP:port SOCKS5 endpoint required")
		}
		dialer, e := proxy.SOCKS5("tcp", socks, nil, &net.Dialer{Timeout: 15 * time.Second})
		if e != nil {
			return nil, e
		}
		contextDialer, ok := dialer.(proxy.ContextDialer)
		if !ok {
			return nil, errors.New("context-aware SOCKS5 dialer required")
		}
		transport.DialContext = contextDialer.DialContext
	} else {
		transport.DialContext = (&net.Dialer{Timeout: 15 * time.Second}).DialContext
	}
	// There is no direct-connect fallback and no environment proxy inheritance.
	return &http.Client{Timeout: 20 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("RPC redirects refused") }}, nil
}

// LocalStateEndpoint prevents selected member/source lookups from leaving a
// holder's machine. A loopback proxy to a hosted RPC does not provide privacy;
// this address must belong to the holder's independently synced full node.
func LocalStateEndpoint(endpoint, socks string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || u.Scheme != "http" || socks != "" {
		return errors.New("private lookups require your own loopback full node without a proxy")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return errors.New("private lookups require your own loopback full node without a proxy")
	}
	return nil
}

// RemoteVerifiedEndpoint admits an untrusted remote node for light mode only.
// The caller must route every read through privatewallet.Oblivious and verify
// it against the pinned genesis; the node is trusted for neither data nor
// privacy. HTTPS (or an onion service over the explicit SOCKS5 proxy) keeps
// the transcript from network observers; plain HTTP is allowed on loopback.
func RemoteVerifiedEndpoint(endpoint, socks string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return errors.New("remote-verified reads require a root HTTPS endpoint without credentials or query")
	}
	host := strings.ToLower(u.Hostname())
	ip := net.ParseIP(host)
	switch {
	case u.Scheme == "https":
		return nil
	case u.Scheme == "http" && ip != nil && ip.IsLoopback() && socks == "":
		return nil
	case u.Scheme == "http" && strings.HasSuffix(host, ".onion") && socks != "":
		return nil
	}
	return errors.New("remote-verified reads require HTTPS, an onion service over SOCKS5, or loopback HTTP")
}
