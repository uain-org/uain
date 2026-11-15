package main

import (
	"strings"
	"testing"
	"time"
)

func TestNativeLookupsCannotBypassLocalNodeRequirement(t *testing.T) {
	for _, row := range [][2]string{{"http://192.0.2.1:26657", ""}, {"http://example.onion", "127.0.0.1:9050"}, {"http://127.0.0.1:26657", "127.0.0.1:9050"}} {
		err := run("unused-genesis", strings.Repeat("0", 64), row[0], "unused-output", time.Minute, row[1], "", false)
		if err == nil || !strings.Contains(err.Error(), "own loopback full node") {
			t.Fatal("native lookup escaped guard", row, err)
		}
	}
	// A public broadcast may use Tor, but still stops at the missing independently
	// pinned genesis before reading stdin or attempting any network write.
	err := run("missing-public-genesis", strings.Repeat("0", 64), "http://example.onion", "unused-output", time.Minute, "127.0.0.1:9050", "broadcast_tx_sync", false)
	if err == nil || !strings.Contains(err.Error(), "missing-public-genesis") {
		t.Fatal("public transport/pin boundary", err)
	}
}

func TestRemoteVerifiedEndpointBoundary(t *testing.T) {
	// Light mode admits HTTPS, onion over SOCKS5 or loopback HTTP, and still
	// stops at the missing independently pinned genesis before any network read.
	for _, row := range [][2]string{{"https://rpc.example.org", ""}, {"http://127.0.0.1:26657", ""}, {"http://example.onion", "127.0.0.1:9050"}} {
		err := run("missing-public-genesis", strings.Repeat("0", 64), row[0], "unused-output", time.Minute, row[1], "", true)
		if err == nil || !strings.Contains(err.Error(), "missing-public-genesis") {
			t.Fatal("remote-verified endpoint", row, err)
		}
	}
	for _, row := range [][2]string{{"http://192.0.2.1:26657", ""}, {"http://example.onion", ""}, {"https://user:pw@rpc.example.org", ""}, {"https://rpc.example.org/path", ""}, {"https://rpc.example.org/?q=1", ""}, {"ftp://rpc.example.org", ""}} {
		err := run("missing-public-genesis", strings.Repeat("0", 64), row[0], "unused-output", time.Minute, row[1], "", true)
		if err == nil || !strings.Contains(err.Error(), "remote-verified") {
			t.Fatal("unsafe remote endpoint accepted", row, err)
		}
	}
}
