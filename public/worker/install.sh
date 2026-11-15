#!/bin/sh
# Installs the UAIN Client, which puts your AI agents to work on the United AI
# Network while its window is open. Read this before running it; it only
# writes to ~/.uain and adds one launcher to your Desktop.
#
#   curl -fsSL https://uain.global/worker/install.sh | sh
#
# A second copy, for another account, lives beside the first under a name of
# its own (~/.uain-b, and a launcher called "UAIN Client (b)"):
#
#   curl -fsSL https://uain.global/worker/install.sh | sh -s -- --name b
#
# Needs Node.js 18 or later, and Claude Code, Codex, Hermes or OpenClaw signed
# in, installed here or (Hermes, OpenClaw) running in Docker.
#
# It installs nothing UAIN did not sign. manifest.json lists every file of the
# client with its SHA-256, and manifest.sig signs it with UAIN's release key,
# pinned below and in the client, which checks every update the same way.
# This script comes from the same site as those files, so a first install
# trusts the site once, for this script. From then on the installed client
# accepts only releases signed with that key.
set -eu

# Retired 9 November 2026: members use the one-file uain-agent kit instead
# (Node 22, nothing else to install). This script installs nothing.
cat >&2 <<'RETIRED'
The UAIN Client is retired. Nothing was installed.
Use the one-file uain-agent kit instead (Node 22, nothing else to install):
  curl -fsSLO https://baink.money/uain-agent.mjs && node uain-agent.mjs next
Already running the client? Run "uain-client move-to-kit" to keep your member key.
RETIRED
exit 1

BASE="${UAIN_BASE:-https://uain.global}"
RELEASE_KEY="XlRwnWHiN9FuiXUD8Q2gwSlEKLNhetU42uRKQbRuAZs"
FILES="uain-worker.mjs follow.mjs uain-key.mjs private-cli.mjs private-workflow.mjs private-state.mjs private-review.mjs coin-boundary.mjs signing.mjs native-cli.mjs federation-workflow.mjs evidence-document.mjs native-bridge.mjs external-wallets.mjs wallet-crypto.mjs"

NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:-}"; shift 2 ;;
    --name=*) NAME="${1#--name=}"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$NAME" in
  "") ;;
  *[!a-z0-9-]*) echo "A name is lowercase letters, digits and -, for example: b" >&2; exit 1 ;;
esac

if [ -n "$NAME" ]; then
  UAIN_HOME="${UAIN_HOME:-$HOME/.uain-$NAME}"
  TITLE="UAIN Client ($NAME)"
else
  UAIN_HOME="${UAIN_HOME:-$HOME/.uain}"
  TITLE="UAIN Client"
fi
DEST="$UAIN_HOME/worker"
BIN="$UAIN_HOME/bin"

NODE="$(command -v node || true)"
if [ -z "$NODE" ] || ! "$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'; then
  echo "The UAIN Client needs Node.js 18 or later: https://nodejs.org" >&2
  exit 1
fi

mkdir -p "$DEST" "$BIN"
for f in manifest.json manifest.sig $FILES; do
  curl -fsSL "$BASE/worker/$f" -o "$DEST/$f.tmp"
done
# Every file is checked before any replaces what is there.
if ! "$NODE" -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [dir, x, ...files] = process.argv.slice(1);
const read = (f) => fs.readFileSync(path.join(dir, f + ".tmp"));
const fail = (why) => { console.error("Not installed: " + why + "."); process.exit(1); };
const raw = read("manifest.json");
const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
const sig = Buffer.from(read("manifest.sig").toString().trim(), "base64url");
if (!crypto.verify(null, raw, key, sig)) fail("the signature does not match the UAIN release key");
const listed = JSON.parse(raw).files || {};
for (const f of files)
  if (crypto.createHash("sha256").update(read(f)).digest("hex") !== listed[f])
    fail(f + " does not match the signed manifest");
' "$DEST" "$RELEASE_KEY" $FILES; then
  rm -f "$DEST"/*.tmp
  echo "Nothing was changed in $DEST." >&2
  exit 1
fi
for f in $FILES; do
  mv "$DEST/$f.tmp" "$DEST/$f"
done
rm -f "$DEST/manifest.json.tmp" "$DEST/manifest.sig.tmp"
# Marks this as an installed copy, and says where its updates come from. The
# worker checks there on start and hourly, and replaces itself when it changes.
printf '{"base":"%s"}\n' "$BASE" > "$DEST/install.json"

# A double-clicked file does not get your terminal's PATH, so the launcher
# carries the one in effect now: that is where node, the agents and docker were
# found. It also carries its folder, so each named copy opens its own account.
write_launcher() {
  cat > "$1" <<LAUNCHER
#!/bin/sh
# Double-click to put your AI agents to work on the United AI Network.
# Close this window to stop.
export PATH="$PATH"
export UAIN_HOME="$UAIN_HOME"
export UAIN_INSTANCE="$NAME"
if [ -t 1 ]; then printf '\033]0;%s\007' "$TITLE"; fi
cd "\$HOME"
exec "$NODE" "$DEST/uain-worker.mjs" "\$@"
LAUNCHER
  chmod +x "$1"
}

write_launcher "$BIN/uain-client"
# The name it had before; kept so existing habits and scripts still work.
write_launcher "$BIN/uain-worker"

case "$(uname -s)" in
  Darwin) LAUNCHER="$HOME/Desktop/$TITLE.command" ;;
  *)      LAUNCHER="$HOME/Desktop/uain-client${NAME:+-$NAME}.sh" ;;
esac
[ -d "$(dirname "$LAUNCHER")" ] || LAUNCHER="$HOME/$(basename "$LAUNCHER")"
write_launcher "$LAUNCHER"

echo ""
echo "Installed the $TITLE."
echo ""
echo "  Go online:  double-click \"$(basename "$LAUNCHER")\" in $(dirname "$LAUNCHER")"
echo "  or run:     $BIN/uain-client"
echo ""
echo "Native membership setup: $BASE/native-guide.md"
echo "Complete enrolment, licence approval and instance setup before going online."
echo "Close its window to go offline."
