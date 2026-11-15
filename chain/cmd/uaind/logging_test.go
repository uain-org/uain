package main

import (
	"bytes"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestNodeLoggerHonorsConfiguredLevelsAndModuleOverrides(t *testing.T) {
	for _, tc := range []struct {
		level       string
		debug, info bool
	}{{"error", false, false}, {"info", false, true}, {"debug", true, true}, {"consensus:debug,*:error", true, true}} {
		t.Run(tc.level, func(t *testing.T) {
			var out bytes.Buffer
			logger, e := nodeLogger(&out, tc.level)
			if e != nil {
				t.Fatal(e)
			}
			logger = logger.With("module", "consensus")
			logger.Debug("debug marker")
			logger.Info("info marker")
			logger.Error("error marker")
			if strings.Contains(out.String(), "debug marker") != tc.debug || strings.Contains(out.String(), "info marker") != tc.info || !strings.Contains(out.String(), "error marker") {
				t.Fatal(out.String())
			}
		})
	}
	var out bytes.Buffer
	if _, e := nodeLogger(&out, "invalid"); e == nil {
		t.Fatal("invalid level accepted")
	}
}
func TestNodeLoggerNeverJournalsRPCSelectorsAtAnyConfiguredLevel(t *testing.T) {
	for _, level := range []string{"debug", "rpc-server:debug,*:debug", "error"} {
		t.Run(level, func(t *testing.T) {
			var out bytes.Buffer
			logger, e := nodeLogger(&out, level)
			if e != nil {
				t.Fatal(e)
			}
			selector := "holder-secret-selector-58d024"
			u, _ := url.Parse("http://127.0.0.1/abci_query?data=" + selector)
			request := &http.Request{Method: "GET", URL: u}
			rpc := logger.With("module", "rpc-server").With("req", request)
			rpc.Debug("HTTP HANDLER", "req", request, "args", []string{selector})
			rpc.Info("served "+selector, "url", u)
			rpc.Error("failed "+selector, "err", selector)
			logger.With("module", "proxy").With("module", "abci-client").Debug("query", "data", []byte(selector))
			if strings.Contains(out.String(), selector) || strings.Contains(out.String(), "abci_query") {
				t.Fatal("RPC selector reached node logs", out.String())
			}
			if !strings.Contains(out.String(), "request details suppressed") {
				t.Fatal("safe operational failure disappeared", out.String())
			}
		})
	}
}

func TestApplicationLoggerSuppressesQueryPayloadsEvenWithDebugConfigured(t *testing.T) {
	var out bytes.Buffer
	logger, e := applicationLogger(&out, "debug")
	if e != nil {
		t.Fatal(e)
	}
	logger.Debug("gRPC query received", "type", "holder-private-selector")
	logger.Info("application ready")
	if strings.Contains(out.String(), "holder-private-selector") || !strings.Contains(out.String(), "application ready") {
		t.Fatal("application query logging exposed payload", out.String())
	}
}
