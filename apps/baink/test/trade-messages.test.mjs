// Every refusal a member sees in Trade deals is one plain sentence (Rahul, 10 November 2026:
// plain words, one clear next step, no internal terms). Steward, central-review and storage
// refusals are for UAIN's own agents and operators and are left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const OPERATOR_ONLY = new Set(['steward_required', 'steward_conflict', 'central_reviewer_required', 'reviewer_conflict', 'policy_clause_required', 'retry_unavailable', 'confirm_unavailable', 'payment_reconciliation_required', 'appeal_not_open', 'invalid_result', 'invalid_outcome', 'not_found', 'trade_deal_storage_invalid', 'capacity', 'trade_capacity', 'invalid_identity', 'invalid_signature', 'authentication_required']);
const JARGON = /\b(reconcil\w*|intent|nullifier|envelope|digest|idempotenc\w*|lock)\b/i;

test('member-facing Trade deal refusals are one plain sentence', async () => {
  const source = await readFile(new URL('../server/trade-deals.mjs', import.meta.url), 'utf8');
  const found = [...source.matchAll(/check\([^;]*?, (\d{3}), '([a-z_]+)', '([^']+)'\)/g)].map(([, status, code, message]) => ({ status: Number(status), code, message }));
  assert.ok(found.length > 40, 'the refusals were found');
  const member = found.filter((x) => !OPERATOR_ONLY.has(x.code));
  for (const { code, message } of member) {
    assert.match(message, /^[A-Z][^.!?]*[.!?]$/, `${code}: "${message}" is not one sentence`);
    assert.doesNotMatch(message, JARGON, `${code}: "${message}" uses an internal term`);
  }
  // The refusals members met in the 10 November acceptance name their next step.
  const byCode = (code) => member.filter((x) => x.code === code).map((x) => x.message);
  assert.ok(byCode('payment_request_expired').every((m) => /pay again/.test(m)));
  assert.ok(byCode('payment_request_locked').every((m) => /wait/.test(m)));
  assert.ok(byCode('deal_changed').every((m) => /read it again/.test(m)));
});
