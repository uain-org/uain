/**
 * The checks behind /ledger/verify, with no React and no imports, so they run
 * in a browser and in Node alike. Given an entry number: its hash is a leaf of
 * its day's Merkle tree, the path reaches the day's root, the root is signed by
 * the pinned ledger key, and that root is the one anchored on Base Sepolia and
 * mirrored on Solana devnet. Mirrors contracts/client/proof.ts and `prove`.
 */
export type VerifyConfig = {
  /** Origin of the UAIN API ('' for same-origin). */
  api: string;
  /** The ledger's public key, pinned in the site's build. */
  pem: string;
  base: { chainId: number; rpc: string; explorer: string; anchor: string };
  solana: { rpc: string; explorer: string; mirror: string };
};

export type Status = 'pass' | 'fail' | 'absent' | 'skipped';
export type Step = { title: string; status: Status; detail: string; link?: { href: string; label: string } };
type Proof = {
  event_id: number; leaf: string; date: string; index: number; leaves: number;
  proof: { position: string; hash: string }[]; root: string; provisional: boolean;
};
type Root = {
  date: string; root: string | null; head: string | null; count: number;
  first_id: number | null; last_id: number | null; provisional: boolean; signature: string;
};
export type Entry = { id: number; hash: string; at?: string; kind?: string; summary?: string };

const HEX = /^[a-f0-9]{64}$/;
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function parent(left: Uint8Array, right: Uint8Array) {
  const joined = new Uint8Array(64);
  joined.set(left);
  joined.set(right, 32);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
}

/** docs/ledger.md, "Daily roots": sha256(left || right); an odd level's last node pairs with itself. */
async function fold(p: Proof): Promise<string> {
  let node = fromHex(p.leaf);
  let index = p.index;
  let width = p.leaves;
  for (const step of p.proof) {
    if (width <= 1) throw new Error('the path is longer than the tree');
    const side = index % 2 === 1 ? 'left' : 'right';
    if (step.position !== side || !HEX.test(step.hash)) throw new Error('a step is on the wrong side for its position');
    const sibling = fromHex(step.hash);
    if (side === 'right' && index === width - 1 && toHex(sibling) !== toHex(node)) {
      throw new Error('the last node of an odd level must pair with itself');
    }
    node = side === 'left' ? await parent(sibling, node) : await parent(node, sibling);
    index = Math.floor(index / 2);
    width = Math.ceil(width / 2);
  }
  if (width !== 1) throw new Error('the path is shorter than the tree');
  return toHex(node);
}

const payload = (r: Root) =>
  JSON.stringify({ date: r.date, root: r.root, head: r.head, count: r.count, first_id: r.first_id, last_id: r.last_id });

async function signatureStatus(r: Root, pem: string): Promise<'pass' | 'fail' | 'unsupported'> {
  let key: CryptoKey;
  try {
    const der = fromBase64(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
    key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return 'unsupported';
  }
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64(r.signature), new TextEncoder().encode(payload(r)));
  return ok ? 'pass' : 'fail';
}

async function getJson<T>(api: string, path: string): Promise<T> {
  const response = await fetch(`${api}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'the RPC refused');
  return body.result as T;
}

const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

async function baseSepolia(r: Root, BASE_SEPOLIA: VerifyConfig['base']): Promise<Step> {
  const title = 'Anchored on Base Sepolia';
  if (!BASE_SEPOLIA.anchor) return { title, status: 'skipped', detail: 'The anchor contract is not deployed yet.' };
  const link = { href: `${BASE_SEPOLIA.explorer}/address/${BASE_SEPOLIA.anchor}`, label: 'The contract on BaseScan' };
  try {
    if (parseInt(await rpc<string>(BASE_SEPOLIA.rpc, 'eth_chainId', []), 16) !== BASE_SEPOLIA.chainId) {
      return { title, status: 'fail', detail: 'The RPC is not Base Sepolia.', link };
    }
    // anchorOf(uint32) returns (root, head, count, lastEventId, anchoredAt).
    const data = `0x8b99e702${day(r.date).toString(16).padStart(64, '0')}`;
    const out = await rpc<string>(BASE_SEPOLIA.rpc, 'eth_call', [{ to: BASE_SEPOLIA.anchor, data }, 'latest']);
    const [root, head, count, last, at] = out.slice(2).match(/.{64}/g) ?? [];
    if (!root || !head || !count || !last || !at) return { title, status: 'fail', detail: 'The contract gave an unexpected answer.', link };
    const anchoredAt = Number(BigInt(`0x${at}`));
    if (!anchoredAt) return { title, status: 'absent', detail: 'Not anchored yet. Each day is anchored after it ends (UTC).', link };
    const same = root === r.root && head === r.head && BigInt(`0x${count}`) === BigInt(r.count) && BigInt(`0x${last}`) === BigInt(r.last_id ?? -1);
    const when = new Date(anchoredAt * 1000).toISOString().replace('T', ' ').slice(0, 16);
    return same
      ? { title, status: 'pass', detail: `The same root, head, count and last entry were fixed on-chain at ${when} UTC, and can never change.`, link }
      : { title, status: 'fail', detail: 'The anchored root differs from the signed root: the ledger no longer matches what was anchored.', link };
  } catch (error) {
    return { title, status: 'skipped', detail: `Base Sepolia could not be read (${(error as Error).message}).`, link };
  }
}

async function solanaDevnet(r: Root, SOLANA_DEVNET: VerifyConfig['solana']): Promise<Step> {
  const title = 'Mirrored on Solana devnet';
  const account = { href: `${SOLANA_DEVNET.explorer}/address/${SOLANA_DEVNET.mirror}?cluster=devnet`, label: 'The mirror address' };
  try {
    const rows = await rpc<{ signature: string; memo: string | null; err: unknown }[]>(SOLANA_DEVNET.rpc, 'getSignaturesForAddress', [
      SOLANA_DEVNET.mirror,
      { limit: 1000 },
    ]);
    const expected = `uain-ledger-v1 ${r.date} root=${r.root} head=${r.head} count=${r.count} first_id=${r.first_id} last_id=${r.last_id} sig=${r.signature}`;
    const ours = rows.filter((row) => !row.err && row.memo?.includes(`uain-ledger-v1 ${r.date} `));
    if (!ours.length) return { title, status: 'absent', detail: 'Not mirrored yet.', link: account };
    const exact = ours.find((row) => row.memo?.replace(/^\[\d+\] /, '') === expected);
    const link = exact ? { href: `${SOLANA_DEVNET.explorer}/tx/${exact.signature}?cluster=devnet`, label: 'The memo transaction' } : account;
    return exact && ours.length === 1
      ? { title, status: 'pass', detail: 'One memo carries this day’s signed root, signature included.', link }
      : { title, status: 'fail', detail: 'The mirrored memo differs from the signed root, or there is more than one.', link };
  } catch (error) {
    return { title, status: 'skipped', detail: `Solana devnet could not be read (${(error as Error).message}).`, link: account };
  }
}

export async function check(id: number, config: VerifyConfig): Promise<{ entry?: Entry; steps: Step[] }> {
  const steps: Step[] = [];
  const proof = await getJson<Proof>(config.api, `/api/ledger/proof/${id}`);
  const entry = await getJson<Entry>(config.api, `/api/events/${id}`);
  if (proof.event_id !== id || !HEX.test(proof.leaf) || !HEX.test(proof.root)) throw new Error('The proof is malformed.');
  if (proof.provisional) {
    return { entry, steps: [{ title: 'A finished day', status: 'absent', detail: 'This entry is from today (UTC). Its day is checked and anchored once it ends.' }] };
  }
  steps.push(
    entry.hash === proof.leaf
      ? { title: 'The entry is a leaf of its day', status: 'pass', detail: `Its hash ${entry.hash.slice(0, 16)}… is leaf ${proof.index + 1} of ${proof.leaves} on ${proof.date}.` }
      : { title: 'The entry is a leaf of its day', status: 'fail', detail: 'The entry’s hash differs from the proof’s leaf.' },
  );
  const root = await getJson<Root>(config.api, `/api/ledger/roots/${proof.date}`);
  let reached = '';
  try {
    reached = await fold(proof);
  } catch (error) {
    reached = (error as Error).message;
  }
  const consistent = root.root === proof.root && root.count === proof.leaves && reached === root.root;
  steps.push(
    consistent
      ? { title: 'The path reaches the day’s root', status: 'pass', detail: `${proof.proof.length} hashing steps lead to the root ${root.root?.slice(0, 16)}…` }
      : { title: 'The path reaches the day’s root', status: 'fail', detail: HEX.test(reached) ? 'The path leads to a different root.' : `The path is invalid: ${reached}.` },
  );
  const signature = await signatureStatus(root, config.pem);
  steps.push(
    signature === 'unsupported'
      ? { title: 'Signed by UAIN’s ledger key', status: 'skipped', detail: 'This browser cannot check Ed25519 signatures. The command-line check below does.' }
      : signature === 'pass'
        ? { title: 'Signed by UAIN’s ledger key', status: 'pass', detail: 'The root’s signature matches the key pinned in this site, not the key the server serves.' }
        : { title: 'Signed by UAIN’s ledger key', status: 'fail', detail: 'The signature does not match the pinned key. On a test copy of the site this is expected: it signs with its own key.' },
  );
  steps.push(await baseSepolia(root, config.base), await solanaDevnet(root, config.solana));
  return { entry, steps };
}
