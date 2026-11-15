// Runs functions of the no-install signer (shared/uain_signer.py) the way a member's own AI
// does in its sandbox: python3, the file as served, no packages required. Test helper only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DRIVER = `
import json, sys
sys.path.insert(0, sys.argv[1])
import uain_signer as s
if len(sys.argv) > 2 and sys.argv[2] == "pure":
    s._public, s._sign, s.ED25519 = s.pure_public, s.pure_sign, "pure-python"
req = json.load(sys.stdin)
try:
    out = getattr(s, req["fn"])(*req.get("args", []), **req.get("kwargs", {}))
    if isinstance(out, (bytes, bytearray)):
        out = {"hex": out.hex()}
    print(json.dumps({"ok": out, "ed25519": s.ED25519}))
except s.SigningRefused as e:
    print(json.dumps({"refused": str(e)}))
`;

/** A signer sandbox holding exactly `text` as uain_signer.py. */
export function signerSandbox(t, text, { pure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uain-signer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'uain_signer.py'), text);
  writeFileSync(join(dir, 'driver.py'), DRIVER);
  const call = (fn, ...args) => {
    const kwargs = args.length && args.at(-1)?.__kwargs ? (({ __kwargs, ...rest }) => rest)(args.pop()) : {};
    const out = JSON.parse(execFileSync('python3', ['-I', '-B', join(dir, 'driver.py'), dir, ...(pure ? ['pure'] : [])], { input: JSON.stringify({ fn, args, kwargs }), encoding: 'utf8' }));
    return out;
  };
  /** The value, or throws with the refusal message. */
  const py = (fn, ...args) => {
    const out = call(fn, ...args);
    if (Object.hasOwn(out, 'refused')) throw Object.assign(new Error(out.refused), { refused: true });
    return out.ok;
  };
  py.raw = call;
  return py;
}
export const kw = (o) => ({ __kwargs: true, ...o });
