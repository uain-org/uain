// Loopback-only CometBFT protocol fixture. Never connects to a production node,
// creates a ledger/member, reads a wallet, or writes private node keys.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cometbft/cometbft/config"
	"github.com/cometbft/cometbft/crypto/ed25519"
	"github.com/cometbft/cometbft/libs/log"
	"github.com/cometbft/cometbft/p2p"
	"github.com/cometbft/cometbft/p2p/conn"
	"github.com/cometbft/cometbft/version"
	"github.com/cosmos/gogoproto/types"
)

const channel = byte(0x31)
const network = "baink-fictional-loopback-relay-capacity-v1"

type probe struct {
	*p2p.BaseReactor
	central bool
	mu      sync.Mutex
	seen    map[string]bool
}

func newProbe(central bool) *probe {
	p := &probe{central: central, seen: map[string]bool{}}
	p.BaseReactor = p2p.NewBaseReactor("bounded-capacity-probe", p)
	return p
}
func (*probe) GetChannels() []*conn.ChannelDescriptor {
	return []*conn.ChannelDescriptor{{ID: channel, Priority: 1, SendQueueCapacity: 8, RecvMessageCapacity: 256, MessageType: &types.StringValue{}}}
}
func (p *probe) Receive(e p2p.Envelope) {
	m, ok := e.Message.(*types.StringValue)
	if !ok || len(m.Value) > 128 {
		return
	}
	if p.central {
		if !strings.HasPrefix(m.Value, "ping:") || !strings.HasSuffix(m.Value, ":"+string(e.Src.ID())) {
			return
		}
		p.mu.Lock()
		p.seen[m.Value] = true
		p.mu.Unlock()
		e.Src.TrySend(p2p.Envelope{ChannelID: channel, Message: &types.StringValue{Value: "ack:" + m.Value}})
	} else if strings.HasPrefix(m.Value, "ack:ping:") {
		p.mu.Lock()
		p.seen[m.Value] = true
		p.mu.Unlock()
	}
}
func (p *probe) has(s string) bool { p.mu.Lock(); defer p.mu.Unlock(); return p.seen[s] }

type node struct {
	sw        *p2p.Switch
	transport *p2p.MultiplexTransport
	reactor   *probe
	id        p2p.ID
	address   *p2p.NetAddress
}

func makeNode(inbound int, central bool) (*node, error) {
	// Use the actual TCP transport/SecretConnection and normal Switch admission;
	// the in-memory peer-set/test helper shortcuts are deliberately not used.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	listen := listener.Addr().String()
	listener.Close()
	cfg := config.DefaultP2PConfig()
	cfg.ListenAddress = "tcp://" + listen
	cfg.AllowDuplicateIP = true
	cfg.AddrBookStrict = false
	cfg.MaxNumInboundPeers = inbound
	cfg.MaxNumOutboundPeers = 1
	cfg.PexReactor = false
	cfg.HandshakeTimeout = 5 * time.Second
	cfg.DialTimeout = 5 * time.Second
	key := p2p.NodeKey{PrivKey: ed25519.GenPrivKey()}
	info := p2p.DefaultNodeInfo{ProtocolVersion: p2p.NewProtocolVersion(version.P2PProtocol, version.BlockProtocol, 0), DefaultNodeID: key.ID(), ListenAddr: listen, Network: network, Version: "0.40.0", Channels: []byte{channel}, Moniker: "fictional-capacity-node", Other: p2p.DefaultNodeInfoOther{TxIndex: "off", RPCAddress: ""}}
	address, err := p2p.NewNetAddressString(string(key.ID()) + "@" + listen)
	if err != nil {
		return nil, err
	}
	transport := p2p.NewMultiplexTransport(info, key, p2p.MConnConfig(cfg))
	if err = transport.Listen(*address); err != nil {
		return nil, err
	}
	sw := p2p.NewSwitch(cfg, transport)
	sw.SetLogger(log.NewNopLogger())
	sw.SetNodeKey(&key)
	sw.SetNodeInfo(info)
	r := newProbe(central)
	sw.AddReactor("capacity-probe", r)
	if err = sw.Start(); err != nil {
		transport.Close()
		return nil, err
	}
	return &node{sw: sw, transport: transport, reactor: r, id: key.ID(), address: address}, nil
}
func (n *node) close() {
	if n == nil {
		return
	}
	n.sw.Stop()
	n.transport.Close()
}
func wait(timeout time.Duration, condition func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return condition()
}
func require(ok bool, message string) {
	if !ok {
		panic(message)
	}
}
func event(v any) { b, _ := json.Marshal(v); fmt.Println(string(b)) }

type result struct {
	InboundLimit      int    `json:"inboundLimit"`
	Requested         int    `json:"requested"`
	Authenticated     int    `json:"authenticated"`
	DialErrors        int64  `json:"dialErrors"`
	EchoRounds        int    `json:"echoRounds"`
	EchoReceipts      int    `json:"echoReceipts"`
	ExtraPeerRejected bool   `json:"extraPeerRejected"`
	HoldMS            int64  `json:"holdMs"`
	HeapBytes         uint64 `json:"heapBytes"`
	Goroutines        int    `json:"goroutines"`
}

func run(limit, requested int, hold time.Duration, exact bool) (out result) {
	central, err := makeNode(limit, true)
	if err != nil {
		panic(err)
	}
	defer central.close()
	clients := make([]*node, requested)
	defer func() {
		for _, n := range clients {
			n.close()
		}
	}()
	for i := range clients {
		clients[i], err = makeNode(0, false)
		if err != nil {
			panic(err)
		}
	}
	var failures atomic.Int64
	var wg sync.WaitGroup
	gate := make(chan struct{}, 32)
	for _, n := range clients {
		wg.Add(1)
		go func(n *node) {
			defer wg.Done()
			gate <- struct{}{}
			defer func() { <-gate }()
			if n.sw.DialPeerWithAddress(central.address) != nil {
				failures.Add(1)
			}
		}(n)
	}
	wg.Wait()
	want := requested
	if want > limit {
		want = limit
	}
	require(wait(15*time.Second, func() bool { return central.sw.Peers().Size() == want }), "authenticated peer count did not reach expected bound")
	time.Sleep(500 * time.Millisecond)
	require(central.sw.Peers().Size() == want, "inbound capacity was exceeded or peers dropped")
	if exact {
		for _, n := range clients {
			require(central.sw.Peers().Has(n.id), "central has a foreign or missing authenticated identity")
			require(n.sw.Peers().Has(central.id), "client did not authenticate central identity")
		}
	}
	out = result{InboundLimit: limit, Requested: requested, Authenticated: central.sw.Peers().Size(), DialErrors: failures.Load()}
	if !exact {
		event(map[string]any{"phase": "baseline-limit", "result": out})
		return out
	}
	extra, err := makeNode(0, false)
	if err != nil {
		panic(err)
	}
	defer extra.close()
	extra.sw.DialPeerWithAddress(central.address)
	require(wait(6*time.Second, func() bool { return extra.sw.Peers().Size() == 0 }), "over-limit peer remained admitted")
	time.Sleep(200 * time.Millisecond)
	require(central.sw.Peers().Size() == limit && !central.sw.Peers().Has(extra.id), "extra peer displaced or exceeded admitted set")
	out.ExtraPeerRejected = true
	started := time.Now()
	for round := 0; time.Since(started) < hold; round++ {
		for _, n := range clients {
			peer := n.sw.Peers().Get(central.id)
			require(peer != nil, "peer lost during sustained check")
			tag := fmt.Sprintf("ping:%d:%s", round, n.id)
			require(peer.TrySend(p2p.Envelope{ChannelID: channel, Message: &types.StringValue{Value: tag}}), "bounded probe send queue refused")
		}
		require(wait(10*time.Second, func() bool {
			for _, n := range clients {
				tag := fmt.Sprintf("ping:%d:%s", round, n.id)
				if !central.reactor.has(tag) || !n.reactor.has("ack:"+tag) {
					return false
				}
			}
			return true
		}), "authenticated bidirectional probe receipts missing")
		out.EchoRounds++
		out.EchoReceipts += requested
		require(central.sw.Peers().Size() == requested, "peer set changed during hold")
		event(map[string]any{"phase": "sustained-authenticated-echo", "round": round, "peers": requested, "elapsedMs": time.Since(started).Milliseconds()})
		remaining := hold - time.Since(started)
		if remaining > 5*time.Second {
			remaining = 5 * time.Second
		}
		if remaining > 0 {
			time.Sleep(remaining)
		}
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	out.HoldMS = time.Since(started).Milliseconds()
	out.HeapBytes = memory.HeapAlloc
	out.Goroutines = runtime.NumGoroutine()
	return out
}
func main() {
	peers := flag.Int("peers", 256, "loopback authenticated peers, maximum256")
	hold := flag.Duration("hold", 60*time.Second, "sustained fixture duration, maximum10minutes")
	flag.Parse()
	if flag.NArg() != 0 || *peers < 1 || *peers > 256 || *hold < time.Second || *hold > 10*time.Minute {
		fmt.Fprintln(os.Stderr, "bounded loopback fixture arguments refused")
		os.Exit(2)
	}
	defer func() {
		if r := recover(); r != nil {
			event(map[string]any{"result": "FAIL", "fixtureOnly": true, "error": fmt.Sprint(r)})
			os.Exit(1)
		}
	}()
	baseline := run(16, 24, time.Second, false)
	target := run(*peers, *peers, *hold, true)
	event(map[string]any{"result": "PASS", "fixtureOnly": true, "productionConnections": 0, "network": network, "cometBft": "0.40.0", "privateKeysWritten": false, "ledgerOrFinancialReadiness": false, "baseline": baseline, "target": target})
}
