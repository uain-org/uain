# Signed ledger root publication

The daily Git archive remains separate from Base Sepolia anchoring and the Solana
devnet mirror. Catch-up success does not establish that a Git copy was published.
On 12 October the hosted publication job was denied before starting by GitHub's
billing limit. The missing 11 October root was independently signature-verified
and copied unchanged to `ledger-roots` at `e1d471095db25992f1baa83c91f5f682504e7a3f`;
a separate GitHub readback matches all 367 bytes. No anchor transaction was sent.

The replacement workflow runs on the existing self-hosted production runner.
A root-installed launcher accepts only `ledger-publication YYYY-MM-DD`, validates
a completed UTC day and runs the original typed publisher in the disposable
container. The ledger public PEM is independently fixed in the suite and trusted
launcher; no API-supplied pin or private key is accepted. The container receives
no Git token, host credentials or Docker socket.

After container success the launcher reads only the fixed per-date public output,
with a 30-second/64-KiB archive bound and 4-KiB JSON bound. It refuses extra files,
links, changed dates, duplicate or extra fields, noncanonical bytes and invalid
signatures. It independently verifies Ed25519 again before emitting only exact
JSON to stdout. Container/source diagnostics go to stderr.

Only the later workflow step receives `GITHUB_TOKEN`. It uses a fresh temporary
Git checkout, refuses symlink destinations and changed existing daily bytes or
ledger pins, and pushes only the `ledger-roots` branch. It runs no npm, publisher
or anchor code with that token. The tested trusted launcher must be reviewed and
installed before the updated workflow is enabled. Retained qualification and
operational replay evidence: `chain/reports/ledger-publication-server-20261012.json`.
