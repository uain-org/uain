package main

import (
	sdklog "cosmossdk.io/log/v2"
	cmtlog "github.com/cometbft/cometbft/libs/log"
	"io"
	"strings"
)

// CometBFT's RPC/ABCI debug logs include full HTTP URLs, selectors and decoded
// replies. This privacy boundary cannot be disabled by a log-level setting.
// Consensus/P2P operational diagnostics still honor configured module levels.
type privateNodeLogger struct {
	next    cmtlog.Logger
	context []any
}

func (l privateNodeLogger) With(kv ...any) cmtlog.Logger {
	next := append(append([]any{}, l.context...), kv...)
	return privateNodeLogger{l.next, next}
}
func privateLogModule(kv []any) bool {
	for i := 0; i+1 < len(kv); i += 2 {
		if key, ok := kv[i].(string); ok && key == "module" {
			if m, ok := kv[i+1].(string); ok {
				switch m {
				case "rpc", "rpc-server", "abci-client", "abci-server":
					return true
				}
			}
		}
	}
	return false
}
func safeLogContext(kv []any, onlyModules bool) []any {
	out := []any{}
	for i := 0; i+1 < len(kv); i += 2 {
		key, ok := kv[i].(string)
		if !ok {
			continue
		}
		value := kv[i+1]
		if onlyModules {
			if key == "module" {
				out = append(out, key, value)
			}
			continue
		}
		switch strings.ToLower(key) {
		case "req", "request", "url", "data", "args", "params", "query", "returns", "response", "remoteaddr":
			value = "[redacted]"
		}
		out = append(out, key, value)
	}
	return out
}
func (l privateNodeLogger) emit(level, msg string, kv []any) {
	context := append(append([]any{}, l.context...), kv...)
	if privateLogModule(context) {
		if level != "error" {
			return
		}
		l.next.With(safeLogContext(context, true)...).Error("RPC/ABCI failure (request details suppressed)")
		return
	}
	logger := l.next.With(safeLogContext(l.context, false)...)
	safe := safeLogContext(kv, false)
	switch level {
	case "debug":
		logger.Debug(msg, safe...)
	case "info":
		logger.Info(msg, safe...)
	case "warn":
		logger.Warn(msg, safe...)
	default:
		logger.Error(msg, safe...)
	}
}
func (l privateNodeLogger) Debug(msg string, kv ...any) { l.emit("debug", msg, kv) }
func (l privateNodeLogger) Info(msg string, kv ...any)  { l.emit("info", msg, kv) }
func (l privateNodeLogger) Error(msg string, kv ...any) { l.emit("error", msg, kv) }
func sdkLogLevel(level string) string {
	parts := strings.Split(level, ",")
	for i, part := range parts {
		if part == "none" {
			parts[i] = "disabled"
		} else if strings.HasSuffix(part, ":none") {
			parts[i] = strings.TrimSuffix(part, "none") + "disabled"
		}
	}
	return strings.Join(parts, ",")
}

func (l privateNodeLogger) Warn(msg string, kv ...any) { l.emit("warn", msg, kv) }

func applicationLogger(output io.Writer, level string) (sdklog.Logger, error) {
	filter, err := sdklog.ParseLogLevel(sdkLogLevel(level))
	if err != nil {
		return nil, err
	}
	return sdklog.NewLogger(output, sdklog.FilterOption(func(module, level string) bool { return level == "debug" || filter(module, level) })), nil
}
