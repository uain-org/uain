// uain-peer-tunnel carries one fixed Comet peer through a local Tor client.
// It has no wallet keys, private record queries or direct-connect fallback.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/uain-org/uain/chain/privatetransport"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:27666", "loopback peer bridge")
	socks := flag.String("socks-proxy", "", "explicit loopback Tor SOCKS listener")
	peer := flag.String("peer", "", "independently obtained v3 onion:port")
	max := flag.Int("max-connections", 4, "bounded peer connections")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := privatetransport.PeerTunnel(ctx, *listen, *socks, *peer, *max); err != nil {
		fmt.Fprintln(os.Stderr, "Peer tunnel refused:", err)
		os.Exit(1)
	}
}
