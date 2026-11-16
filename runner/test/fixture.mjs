import fs from 'node:fs/promises';
import { FILES, verifiedManifest } from '../fetch-client.mjs';

export async function signedFixture() {
  const bundle = {};
  for (const name of ['manifest.json', 'manifest.sig', ...FILES]) {
    if (process.env.UAIN_RUNNER_SIGNED_FIXTURE)
      bundle[name] = await fs.readFile(`${process.env.UAIN_RUNNER_SIGNED_FIXTURE}/${name}`);
    else {
      const res = await fetch(`https://uain.global/worker/${name}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Signed fixture ${name}: ${res.status}`);
      bundle[name] = Buffer.from(await res.arrayBuffer());
    }
  }
  verifiedManifest(bundle['manifest.json'], bundle['manifest.sig']);
  return bundle;
}
