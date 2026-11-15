# Node logging privacy

`uaind start` applies `config.toml`'s `log_level` to CometBFT and the SDK
application logger. Invalid levels stop startup. Consensus and P2P module
settings continue to control operational diagnostics.

RPC and ABCI debug logs previously included full HTTP URLs, request selectors,
arguments and replies. These module debug/info/warn entries are now suppressed
at the logger boundary, including nested logger contexts and explicit debug
configuration. Errors from these modules emit a fixed operational failure
message without the original message, request, remote address or error details.
Other modules redact request-bearing structured fields. The SDK application's
debug entries are always suppressed because its gRPC query debug path logs the
complete decoded request. Application info/warn/error entries retain configured
level filtering. This deliberate privacy restriction cannot be disabled through
`log_level`; consensus/P2P debug diagnostics remain available.

This protects the node's own log sink. It does not change reverse proxies,
transport access logs, operating-system tracing or pre-existing journals.
Existing exposed logs require a separately authorized retention review.

Qualification uses actual CometBFT/SDK logger implementations with HTTP request
objects, nested contexts and selector-bearing error strings. Tests require
absence of plaintext selectors and request URLs under info/error/debug and
module overrides, while preserving safe operational errors and permitted
consensus diagnostics. No live node is changed by these tests.
