// The guide answers a member's own AI repeats (baink_guide and uain_guide share one
// answer bank). 10 November 2026: honest review times, where the AI$ went, received
// AI$, the read-only Trade server and a passphrase that never enters a chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWERS, JOURNEY, guideAnswer } from '../server/guide-answers.mjs';
import { MCP_INSTRUCTIONS, MCP_TOOLS, HINTS } from '../agent-kit/uain-agent.mjs';

const ask = (question) => guideAnswer('baink', { question });
const answer = (topic) => ANSWERS.find((a) => a.topic === topic).answer;

test('no answer promises a 2 to 10 minute review without saying it can take up to an hour', () => {
  const texts = [...ANSWERS.map((a) => a.answer), ...JOURNEY, MCP_INSTRUCTIONS, ...MCP_TOOLS.map((t) => t.description), ...Object.values(HINTS)];
  for (const text of texts) if (/2 to 10 minutes/.test(text)) assert.match(text, /up to an hour/, text.slice(0, 80));
  for (const q of ['my review is taking long, is it delayed?', 'Why is my review delayed?', 'What happened to my submission?']) {
    const r = ask(q);
    assert.equal(r.topic, 'review', q); assert.equal(r.match, 'strong', q);
    assert.match(r.answer, /"review delayed" and why after about 15 minutes/);
    assert.match(r.answer, /at most 16 an hour/);
    assert.match(r.answer, /never send it again/);
    assert.equal(r.nextStep.tool, 'baink_agent_history');
  }
});

test('the guide explains where the AI$ went and what received AI$ can and cannot do', () => {
  for (const q of ['status shows 100 AI$ earned but balance 99.1, where did 0.9 go?', 'I was paid for a deal but my balance shows 0']) {
    const r = ask(q);
    assert.equal(r.topic, 'earned', q);
    assert.match(r.answer, /no fee is charged on payments or Trade/);
    assert.match(r.answer, /received: it is yours, but it is not in the balance and cannot be spent or sent on today \(that is not built yet\)/);
    assert.equal(r.nextStep.tool, 'baink_agent_status');
  }
  // Nothing promises that received AI$ will become spendable, or by when.
  for (const topic of ['earned', 'pay', 'receive', 'trade']) assert.doesNotMatch(answer(topic), /will be spendable|spendable soon|coming soon/i, topic);
  assert.match(answer('pay'), /AI\$ other members paid you cannot be paid on yet/);
  assert.match(answer('receive'), /next tells you to confirm it/);
});

test('while Trade is paused (the default) the Trade answer says so and suggests no new listing', () => {
  const r = ask('how do I sell a service on trade?');
  assert.equal(r.topic, 'trade');
  assert.match(r.answer, /^Trade is paused for new business/);
  assert.match(r.answer, /already agreed, paid or in dispute can still be finished/);
  assert.match(r.answer, /trade_paused; do not retry/);
  assert.doesNotMatch(r.answer, /offer_create|trade-act enquire/);
  assert.equal(r.nextStep.tool, 'baink_tasks');
  for (const text of [...JOURNEY, answer('no-tasks'), answer('check-work'), answer('value')])
    assert.doesNotMatch(text, /sell(ing)? a service|offer a service|selling services/, text.slice(0, 80));
});

test('Trade answers say the MCP servers only read and name the kit command', () => {
  const r = guideAnswer('baink', { question: 'can I do trade writes on this MCP server?' }, { tradeMode: 'open' });
  assert.equal(r.topic, 'trade');
  assert.match(r.answer, /these MCP servers only read it \(baink_trade\)/);
  assert.match(r.answer, /node uain-agent\.mjs trade-act <action>/);
  assert.match(r.answer, /never pay it again/);
  assert.ok(r.answer.length < 800);
});

test('the key answer never asks for a passphrase in a chat or tool call', () => {
  const r = ask('how do I back up my key?');
  assert.equal(r.topic, 'key');
  assert.match(r.answer, /never typed into a chat or a tool call/);
  assert.deepEqual(r.nextStep.args, {}, 'the suggested backup call carries no passphrase');
  for (const a of ANSWERS) assert.ok(!Object.hasOwn(a.next?.kit?.args ?? {}, 'passphrase'), a.topic);
});

test('membership: the guide says where the one line is, in plain words', () => {
  assert.match(answer('start'), /enrol ends with one line saying whether it is active/);
  assert.match(answer('refusal'), /status says whether it is active/);
  for (const a of ANSWERS) assert.doesNotMatch(a.answer, /guardian|finalized: false|activation pending/i, a.topic);
  // The answers this change rewrote stay short enough to read in one go.
  for (const topic of ['start', 'review', 'earned', 'pay', 'receive', 'trade', 'refusal', 'key', 'find']) assert.ok(answer(topic).length < 800, topic + ' is ' + answer(topic).length);
  assert.ok(Buffer.byteLength(JSON.stringify(guideAnswer('baink', {}))) < 8000, 'the first screen stays small');
});
