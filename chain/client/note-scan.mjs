// Note scanning (formerly the light wallet; the downloadable wallet product was
// retired 9 Nov 2026). Reads any untrusted remote node through the pinned
// reader's remote-verified mode, then finds a key's own notes locally: every
// ciphertext record is trial-decrypted on this machine and spentness is
// checked against the complete proven nullifier set. The remote node learns
// nothing about which notes are the key's. Used by the devnet smokes, and the
// basis for spending received notes with nothing installed (phase 2).
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { readPrivateState } from './private-state.mjs';
import { verifyPrivateExecutable } from './private-workflow.mjs';

const HASH = /^[0-9a-f]{64}$/;
const check = (ok, message) => { if (!ok) throw new Error(message); };

// One complete, verified light snapshot: commitments, records and nullifiers.
export async function lightScan(reader, { witnessPositions } = {}) {
  const request = { light_scan: true };
  if (witnessPositions?.length) request.witness_positions = witnessPositions;
  const state = await readPrivateState({ ...reader, remoteVerified: true, request });
  check(state.light_scan === true && Array.isArray(state.records) && Array.isArray(state.nullifiers) && Array.isArray(state.commitments), 'light snapshot required');
  check(BigInt(state.count) === BigInt(state.commitments.length) && BigInt(state.records.length) * 2n === BigInt(state.count) && BigInt(state.nullifiers.length) === BigInt(state.count), 'incomplete light snapshot');
  return state;
}

function noteProcess(executable, spendingKeyFile, input, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [spendingKeyFile], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 8192) child.kill('SIGKILL'); else output += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('note decryption tool refused'));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('invalid note decryption output')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
  });
}

const UNITS = /^(0|[1-9][0-9]{0,19})$/;
const units = value => { check(typeof value === 'string' && UNITS.test(value) || typeof value === 'bigint' && value >= 0n, 'canonical unit amount required'); return BigInt(value); };
function spendableSummary(unspent) {
  const max = unspent.reduce((top, n) => BigInt(n.amountUnits) > top ? BigInt(n.amountUnits) : top, 0n);
  return { spendableMaxUnits: max.toString(), unspentNoteCount: unspent.length };
}
// One payment spends one note. Refuse before any review when no single note
// covers the amount, even though the summed balance might.
export function checkSpendable(balance, amountUnits) {
  check(balance && typeof balance === 'object', 'wallet balance required');
  const amount = units(amountUnits), total = units(balance.balanceUnits ?? '0');
  const max = balance.spendableMaxUnits !== undefined ? units(balance.spendableMaxUnits) : units(spendableSummary((balance.notes ?? []).filter(n => !n.spent)).spendableMaxUnits);
  check(amount > 0n, 'payment amount must be positive');
  check(amount <= total, `balance is ${total}; this payment needs ${amount}`);
  check(amount <= max, `largest single note is ${max}; this payment needs one note of at least ${amount}`);
  return { spendable: true, amountUnits: amount.toString(), spendableMaxUnits: max.toString(), balanceUnits: total.toString() };
}

// Trial-decrypt every proven record with the local spending key. The key file
// is opened only by the pinned note tool; this module never reads it.
export async function ownedNotes({ scan, noteTool, spendingKeyFile }) {
  check(scan?.light_scan === true, 'verified light snapshot required');
  const info = await lstat(spendingKeyFile);
  check(info.isFile() && !info.isSymbolicLink() && info.size === 32 && !(info.mode & 0o077) && (!process.getuid || info.uid === process.getuid()), 'private 32-byte spending key file required');
  const executable = await verifyPrivateExecutable(noteTool);
  const positions = new Map();
  scan.commitments.forEach((cmx, index) => positions.set(cmx, positions.has(cmx) ? -1 : index));
  const spent = new Map(scan.nullifiers.map(n => [n.nullifier, n.record]));
  const notes = [];
  for (const record of scan.records) {
    const bundle = Buffer.from(record.bundle, 'base64url');
    const value = await noteProcess(executable, spendingKeyFile, { effects: record.id, bundle_hex: bundle.toString('hex') });
    check(value?.effects === record.id && value.positionScope === 'bundle-action' && Array.isArray(value.outputs) && value.outputs.length <= 2, 'note tool output refused');
    for (const note of value.outputs) {
      check(/^[a-f0-9]{86}$/.test(note.address) && /^(0|[1-9][0-9]{0,18})$/.test(note.amount) && HASH.test(note.commitment) && HASH.test(note.nullifier), 'owned note refused');
      if (BigInt(note.amount) === 0n) continue;
      const position = positions.get(note.commitment);
      check(Number.isInteger(position) && position >= 0, 'owned commitment absent or ambiguous in the authenticated tree');
      notes.push({ kind: record.kind, id: record.id, recordHeight: record.height, position, address: note.address, amountUnits: note.amount, spent: spent.has(note.nullifier), spentBy: spent.get(note.nullifier) ?? null });
    }
  }
  const unspent = notes.filter(n => !n.spent);
  return {
    chainId: scan.chain_id, height: scan.height, appHash: scan.app_hash, headerTime: scan.header_time,
    noteRoot: scan.root, noteCount: scan.count, scannedRecords: scan.records.length,
    balanceUnits: unspent.reduce((sum, n) => sum + BigInt(n.amountUnits), 0n).toString(),
    // Every payment spends exactly one note, so the largest single unspent note,
    // not the sum, bounds one payment. (noteCount above is the proven tree size.)
    ...spendableSummary(unspent),
    notes,
    proof: { kind: 'remote-verified-light-scan', remote: scan.light ?? null, completeness: 'records*2 = nullifiers = proven note count' },
  };
}
