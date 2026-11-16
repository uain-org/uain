/**
 * Anchor one day's UAIN ledger root on Base Sepolia.
 *
 *   node scripts/anchor-root.mjs [YYYY-MM-DD]            dry run (default)
 *   node scripts/anchor-root.mjs 2026-09-24 --send       submit the transaction
 *
 * Environment:
 *   UAIN_API               default https://uain.global
 *   LEDGER_ANCHOR_ADDRESS  the deployed LedgerAnchor
 *   BASE_SEPOLIA_RPC       JSON-RPC URL (also required for verified dry runs)
 *   ANCHORER_PRIVATE_KEY   0x-prefixed key of the anchorer (required for --send)
 *   LEDGER_PUBLIC_KEY_FILE independently pinned Ed25519 public PEM for --send
 *   LEDGER_OWNER_ADDRESS   owner pinned independently of RPC
 *   LEDGER_ANCHOR_START_DATE first scan date when the contract is empty
 *
 * For backlog recovery prefer `operations.mjs catchup`. Sending also requires
 * explicit gas/fee caps; see README. Helpers below preserve the legacy import
 * API, while every executable path uses the typed verified operations client.
 *
 * The date defaults to yesterday (UTC): a day is only final once it is over.
 */
import { pathToFileURL } from 'node:url';

/** Days since the Unix epoch, as the contract counts them. */
export function dayNumber(isoDate) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== isoDate || ms < 0) throw new Error(`bad date ${isoDate}`);
  return Math.floor(ms / 86_400_000);
}

function counter(value, field) {
  if ((typeof value === 'number' && !Number.isSafeInteger(value)) ||
      (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)))) throw new Error(`invalid ${field}`);
  const n = BigInt(value);
  if (n <= 0n || n > 18_446_744_073_709_551_615n) throw new Error(`invalid ${field}`);
  return n;
}

/** The ledger publishes 64-hex digests without a prefix; the chain wants bytes32. */
export function toBytes32(hex, field) {
  const clean = String(hex ?? '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error(`${field} is not a 32-byte hex digest: ${hex}`);
  return `0x${clean}`;
}

export function anchorArgs(rootDoc, isoDate) {
  if (rootDoc.date && rootDoc.date !== isoDate)
    throw new Error(`asked for ${isoDate} but the ledger returned ${rootDoc.date}`);
  if (!rootDoc.count) throw new Error(`no ledger entries on ${isoDate}: nothing to anchor`);
  if (rootDoc.provisional === true) throw new Error('refusing provisional root');
  const count = counter(rootDoc.count, 'count');
  const first = counter(rootDoc.first_id, 'first_id');
  const last = counter(rootDoc.last_id, 'last_id');
  if (last < first || count > last - first + 1n) throw new Error('invalid event range');
  return [
    dayNumber(isoDate),
    toBytes32(rootDoc.root, 'root'),
    toBytes32(rootDoc.head, 'head'),
    count,
    last,
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const date = args[0] && !args[0].startsWith('--') ? args.shift() : undefined;
  import('../dist/cli.js').then(({ main }) => main(['anchor', ...(date ? ['--date', date] : []), ...args])).catch(() => {
    console.error('Anchoring failed. Check configuration, roots and journal; no automatic mutation retry occurred.');
    process.exitCode = 1;
  });
}
