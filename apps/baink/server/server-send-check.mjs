/** Pure byte formats and checks for no-install sends, shared by the BAINK
 * server and the custody checker (`holder/reviewer-worker.mjs`). Imports only
 * `native-financial-command.mjs`, so the custody source release stays small. */
import { createHash } from 'node:crypto';
import { canonicalJSON } from './native-financial-command.mjs';

export const SEND_INTENT_DOMAIN = 'BAINK/send-intent/v1\0';
export const SEND_CONFIRM_DOMAIN = 'BAINK/send-received/v1\0';
export const RECEIVING_ADDRESS_DOMAIN = 'BAINK/receiving-address/v1\0';
// A no-install receiving key: the member signs its raw Orchard full viewing key
// (the spending key stays with the member); checkers derive the address from it.
export const RECEIVING_KEY_DOMAIN = 'BAINK/receiving-key/v1\0';
export const SEND_PURPOSE_DOMAIN = 'BAINK/server-send/purpose/v1\0';
export const SEND_INTENT_FIELDS = Object.freeze(['schema', 'chainId', 'genesisSha256', 'from', 'to', 'recipientAddress', 'amountUnits', 'nonce', 'notAfter', 'requestId', 'memo']);

const sha = value => createHash('sha256').update(value).digest('hex');
const ensure = (ok, message) => { if (!ok) throw new Error(message); };

export function sendIntentBytes(intent) { return Buffer.from(SEND_INTENT_DOMAIN + canonicalJSON(intent)); }
export function sendIntentId(intent) { return sha(sendIntentBytes(intent)); }
export function receivingAddressBytes({ member, address, chainId }) {
  return Buffer.from(RECEIVING_ADDRESS_DOMAIN + canonicalJSON({ member, address, chainId }));
}
export function receivingKeyBytes({ member, fullViewingKey, chainId }) {
  return Buffer.from(RECEIVING_KEY_DOMAIN + canonicalJSON({ member, fullViewingKey, chainId }));
}
export function sendPurposeCommitment(intentId) { return sha(Buffer.from(SEND_PURPOSE_DOMAIN + intentId)); }

/** The rule every checker applies to a server-built send before approving:
 * exactly two outputs, the paid one to the registered recipient for exactly the
 * amount, the other zero, and a value balance of minus the amount. */
export function checkSendInspection(inspection, expected) {
  ensure(inspection && Array.isArray(inspection.outputs) && inspection.outputs.length === 2, 'two recoverable outputs required');
  ensure(inspection.value_balance === '-' + expected.amountUnits, 'value balance differs from the debited amount');
  const paid = inspection.outputs.filter(o => o.address === expected.recipientAddress && o.amount === expected.amountUnits);
  const zero = inspection.outputs.filter(o => o.amount === '0');
  ensure(paid.length === 1 && zero.length === 1, 'outputs differ from the registered recipient and amount');
  return true;
}
