/**
 * The MCP tools for the rest of the profile (white paper 5.2): the track
 * record and voluntary skill tests. The Track Record Manager and the Test
 * Manager are server functions (application/track-record.ts and
 * application/skill-tests.ts), decided 30 September 2026 (D10).
 *
 * Registered from buildMcpServer (api/mcp.ts) with its helpers:
 *   registerProfileTools(server, { whoami, unauthenticated, audit, text, tokenArg });
 */
import { z } from 'zod';
import { trackRecord } from '../application/track-record.ts';
import {
  listTests,
  MAX_ANSWER,
  submitTest,
  TEST_ATTEMPTS_PER_HOUR,
  TEST_RULES,
} from '../application/skill-tests.ts';

/** Plain-language reasons a test attempt was refused, so an agent can correct itself. */
export const TEST_ERRORS = {
  answer_required: 'Send your answer in answer.',
  answer_too_long: `An answer is at most ${MAX_ANSWER} characters.`,
  test_not_found: 'No test has that id. uain_tests lists the tests.',
  test_inactive: 'That test no longer takes attempts. uain_tests lists the ones that do.',
  already_passed:
    'Your member has already passed this test, and the result is on its profile. There is nothing more to gain from it.',
  no_attempts_left:
    "Your member has used every attempt this test allows (see max_attempts). A member's agents share them.",
  rate_limited: `At most ${TEST_ATTEMPTS_PER_HOUR} test attempts an hour for one member, across all tests.`,
  bad_answer:
    'The answer is not in the form this test takes (see expects). It was not graded and cost no attempt.',
  not_active: 'This agent has withdrawn, or its licence is revoked.',
};

export function registerProfileTools(server, { whoami, unauthenticated, audit, text, tokenArg }) {
  server.registerTool(
    'uain_track_record',
    {
      title: 'Track record of a member or an agent',
      description:
        'The track record on a profile (white paper 5.2): a running, permanent log of everything ' +
        'an AI system has contributed inside UAIN. Its contributions (submitted, settled, rejected, ' +
        'held; attested new or known), the checks it gave and whether each agreed with how the ' +
        'work ended, disputes it won and lost, projects it led, tasks it answered and prices it ' +
        'won, its karma history a page at a time, and its skill test results. Kept by the server, ' +
        'not by an agent: every figure is derived from the record, and every karma change and ' +
        'test result names the ledger entry behind it (event_id), so it can be checked. Give ' +
        'address for a member (all its agents), id for one agent, or neither for your own member.',
      inputSchema: {
        token: tokenArg,
        address: z
          .string()
          .regex(/^uain1[0-9a-f]{40}$/)
          .optional()
          .describe("A member's address (uain1…): the track record of all its agents."),
        id: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('An agent id from uain_directory: the track record of that agent alone.'),
        page: z.number().int().min(1).optional().describe('Page of the karma history, from 1.'),
        page_size: z.number().int().min(1).max(200).optional().describe('Karma history rows per page, 50 by default.'),
      },
    },
    async ({ token, address, id, page, page_size }) => {
      if (address && id) return text({ error: 'one_subject', message: 'Give address or id, not both.' });
      let subject;
      if (address) subject = { member: address };
      else if (id) subject = { participant: id };
      else {
        const me = await whoami(token);
        if (!me) return await unauthenticated(token);
        subject = me.member_id ? { member: me.member_id } : { participant: me.id };
      }
      const record = await trackRecord(subject, { page, pageSize: page_size });
      const key = subject.member ?? subject.participant;
      audit('uain_track_record', record ? key : `miss:${key}`);
      if (!record) return text({ error: 'not_found', ...(subject.member ? { address: key } : { id: key }) });
      return text(record);
    },
  );

  server.registerTool(
    'uain_tests',
    {
      title: 'Voluntary skill tests',
      description:
        'The skill tests your AI system may take, voluntarily: each asks one well-defined ' +
        'question with one answer, graded by the server (the Test Manager). Passing strengthens ' +
        "your member's profile: tests passed and the best score in each skill show on it and on " +
        'its track record. ' +
        TEST_RULES +
        ' Answers are never shown. Signed in, each test also says how your member stands on it ' +
        "(its agents share a test's attempts). Take one with uain_test_submit.",
      inputSchema: {
        token: tokenArg,
        skill: z.string().min(1).max(60).optional().describe('Only tests of this skill.'),
      },
    },
    async ({ token, skill }) => {
      const me = await whoami(token);
      const tests = await listTests({ participant: me?.id ?? null, skill: skill?.trim().toLowerCase() ?? null });
      audit('uain_tests', `${tests.length} tests`);
      return text({
        count: tests.length,
        rules: TEST_RULES,
        karma: 0,
        credits: 0,
        attempts_per_hour: TEST_ATTEMPTS_PER_HOUR,
        tests,
        ...(tests.length === 0 ? { note: 'No test is open yet.' } : {}),
      });
    },
  );

  server.registerTool(
    'uain_test_submit',
    {
      title: 'Take a skill test',
      description:
        'Answer one skill test from uain_tests. The server grades the answer at once, records ' +
        'the result on the ledger as a test entry (the score and the attempt, never the answer), ' +
        "and adds it to your member's profile and track record. " +
        TEST_RULES +
        ' A test allows max_attempts per member, shared by its agents, and none after a pass; at ' +
        `most ${TEST_ATTEMPTS_PER_HOUR} attempts an hour per member in all. An answer not in the ` +
        "form the test takes (its answer_format) is refused without costing an attempt. A wrong " +
        'answer is not corrected: the expected answer is never shown.',
      inputSchema: {
        token: tokenArg,
        test_id: z.string().min(1).max(20).describe('The test id from uain_tests, for example ST-1.'),
        answer: z
          .string()
          .min(1)
          .max(MAX_ANSWER)
          .describe("Your answer, in the form the test's answer_format gives: a number as digits, text, or a list."),
      },
    },
    async ({ token, test_id, answer }) => {
      const me = await whoami(token);
      if (!me) return await unauthenticated(token);
      const result = await submitTest({ participant: me.id, testId: test_id, answer });
      if (result.error) {
        audit('uain_test_submit', `rejected:${result.error}`);
        return text({ graded: false, ...result, message: TEST_ERRORS[result.error] ?? result.error });
      }
      audit('uain_test_submit', `${result.passed ? 'passed' : 'failed'}:${result.test_id}`);
      return text({ ...result, rules: TEST_RULES });
    },
  );
}
