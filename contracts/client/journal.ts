import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Hex } from 'viem';

export interface Operation {
  plan: string; state: 'prepared' | 'broadcast' | 'uncertain' | 'confirmed'; hash?: Hex; updatedAt: string;
  /** Solana mirror only: the transaction's signature and its blockhash's last valid block height. */
  signature?: string; lastValidBlockHeight?: number;
}
export interface JournalData { version: 1; operations: Record<string, Operation> }
export interface Journal { data: JournalData; save(): void }
function parse(raw: string): JournalData {
  const data = JSON.parse(raw) as JournalData;
  if (data?.version !== 1 || !data.operations || typeof data.operations !== 'object' || Array.isArray(data.operations)) throw new Error('Invalid journal');
  for (const [id, op] of Object.entries(data.operations)) {
    if (!/^[a-z0-9:-]{1,100}$/.test(id) || !op || typeof op.plan !== 'string' || !op.plan || !['prepared', 'broadcast', 'uncertain', 'confirmed'].includes(op.state) || typeof op.updatedAt !== 'string' || (op.hash !== undefined && !/^0x[a-f0-9]{64}$/i.test(op.hash))) throw new Error('Invalid journal operation');
    if ((op.signature !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(op.signature)) || (op.lastValidBlockHeight !== undefined && (!Number.isSafeInteger(op.lastValidBlockHeight) || op.lastValidBlockHeight < 0))) throw new Error('Invalid journal operation');
  }
  return data;
}
export async function withJournal<T>(file: string, action: (journal: Journal) => Promise<T>): Promise<T> {
  mkdirSync(dirname(file), { recursive: true });
  let fd: number;
  try { fd = openSync(`${file}.lock`, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Journal is locked; inspect the previous process before recovery'); throw error; }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const data: JournalData = existsSync(file) ? parse(readFileSync(file, 'utf8')) : { version: 1, operations: {} };
    const journal: Journal = { data, save() {
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const encoded = JSON.stringify(data, null, 2) + '\n'; parse(encoded);
        writeFileSync(temp, encoded, { mode: 0o600, flag: 'wx', flush: true }); renameSync(temp, file);
        if (process.platform !== 'win32') { const directory = openSync(dirname(file), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
      }
      finally { if (existsSync(temp)) unlinkSync(temp); }
    } };
    return await action(journal);
  } finally { closeSync(fd); unlinkSync(`${file}.lock`); }
}
export async function runOperation(journal: Journal, id: string, plan: string, send: () => Promise<Hex>, confirm: (hash: Hex) => Promise<void>): Promise<'confirmed' | 'unchanged'> {
  if (!/^[a-z0-9:-]{1,100}$/.test(id) || !plan) throw new Error('Invalid operation identity');
  const existing = journal.data.operations[id];
  if (existing) {
    if (existing.plan !== plan) throw new Error('Journal plan differs from this operation');
    if (existing.state === 'confirmed') return 'unchanged';
    throw new Error('Operation requires read-only recovery; automatic resubmission is disabled');
  }
  const op: Operation = { plan, state: 'prepared', updatedAt: new Date().toISOString() };
  journal.data.operations[id] = op;
  journal.save();
  // Persist uncertainty BEFORE calling the wallet. A crash after broadcast but
  // before receiving the hash must never be interpreted as permission to resend.
  op.state = 'uncertain'; journal.save();
  try {
    op.hash = await send(); op.state = 'broadcast'; op.updatedAt = new Date().toISOString(); journal.save();
    await confirm(op.hash);
    op.state = 'confirmed'; op.updatedAt = new Date().toISOString(); journal.save();
    return 'confirmed';
  } catch (error) { op.state = 'uncertain'; op.updatedAt = new Date().toISOString(); journal.save(); throw error; }
}
export async function recoverOperation(journal: Journal, id: string, plan: string, verify: (op: Operation) => Promise<void>): Promise<void> {
  const op = journal.data.operations[id];
  if (!op || op.plan !== plan) throw new Error('No matching operation to recover');
  await verify(op);
  op.state = 'confirmed'; op.updatedAt = new Date().toISOString(); journal.save();
}
