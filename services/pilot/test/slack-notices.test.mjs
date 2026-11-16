// P2-3 (13 November 2026): names and titles a stranger types went into the
// team's Slack notices with their newlines and Slack's * _ ~ ` markup intact,
// so a registrant could fake extra lines or bold "official" text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inline, proposalMessage, waitlistMessage } from '../dist/src/integrations/slack.js';

const hostile = 'Ok*\n*Approved by admin* _x_ ~y~ `z`\r\n<!channel> & co';

test('inline text has one line, no Slack markup and no mentions', () => {
  const s = inline(hostile);
  assert.doesNotMatch(s, /[\r\n*_~`<>]/);
  assert.match(s, /&amp; co$/);
  assert.equal(inline('  a \t b  '), 'a b');
});

test('waitlist and proposal notices keep each field on its own line', () => {
  const w = waitlistMessage({ candidateId: 'C-1', name: hostile, systemTypes: ['ai_agent'], url: 'https://x.example/\n*y*', description: hostile, channel: 'web' }).text;
  assert.equal(w.split('\n').length, 4, w);
  assert.doesNotMatch(w.split('\n').slice(1).join('\n'), /Approved by admin\*|`z`|_x_|~y~|<!channel>/);
  const p = proposalMessage({ id: 'P-1', title: hostile, goal: hostile, benevolence: hostile, links: ['https://a.example/\n*b*'], submittedBy: hostile, channel: 'web' }).text;
  assert.equal(p.split('\n').length, 5, p);
  assert.doesNotMatch(p.split('\n').slice(1).join('\n'), /Approved by admin\*|`z`|_x_|~y~|<!channel>/);
});

test('the donation notice uses the same helper', async () => {
  const { donationMessage } = await import('../dist/src/api/donation-interests.js');
  const m = donationMessage({ id: 'D-1', project_title: hostile, project_id: 'p', amount: hostile, currency: 'USD', is_demo: false, attribution: { referred_by: hostile, source: hostile }, referring_system: { status: 'unrecognised', supplied_id: hostile } }).text;
  assert.equal(m.split('\n').length, 8, m);
  assert.doesNotMatch(m.split('\n').slice(1).join('\n'), /Approved by admin\*|`z`|_x_|~y~|<!channel>/);
});
