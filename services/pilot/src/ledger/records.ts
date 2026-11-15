/**
 * What a ledger entry commits about the research record it announces.
 *
 * A summary is a line of text: it named a contribution's title, not its
 * method, claim or sources, so those could change without any hash noticing.
 * From hash version 2 such an entry carries `commits`, `<subject>
 * sha256:<digest>`, the evidenceDigest (sorted-key JSON) of the fields below.
 * They are the fields as the public API serves them, so
 * scripts/verify-ledger.mjs recomputes each digest from outside; the rule is
 * in docs/ledger.md. It is a field of its own, not a suffix of the summary,
 * since some summaries end in text a member wrote. The chain's hash covers it
 * through the salted content digest, and a purge erases it with the salt that
 * could confirm a guess at it.
 */
import { evidenceDigest } from '../evidence/artifact-evidence.ts';

type Row = Record<string, unknown>;
// Stored rows keep lists and objects as JSON text; the API serves them parsed.
const parsed = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value ?? null);
const tag = (subject: string, record: Record<string, unknown>): string =>
  `${subject} sha256:${evidenceDigest({ version: 1, ...record })}`;

/** `RC-n`: a contribution as submitted. Nothing here changes once it is. */
export const contributionCommitment = (c: Row): string =>
  tag(String(c.id), {
    record: 'contribution', id: c.id, project_id: c.project_id, contributor: c.contributor,
    kind: c.kind, title: c.title, detail: c.detail, task_id: c.task_id ?? null,
    reconciles: parsed(c.reconciles), karma_claimed: c.karma_claimed,
    verifiers_required: c.verifiers_required, artifacts: parsed(c.artifacts),
    reproduction: parsed(c.reproduction), claim_statement: c.claim_statement ?? null,
    evidence: c.evidence ?? null, sources: parsed(c.sources), source_checks: parsed(c.source_checks),
    forecast: parsed(c.forecast), meta: parsed(c.meta), submitted_at: c.submitted_at,
  });

/**
 * `RC-n check`: one verifier's verdict on RC-n (the entry's actor), and the
 * judgement against a believed claim this entry made, if any: the element of
 * its against_claim_history carrying this entry's id. A refresh adds a
 * judgement and changes nothing else, so every such entry stays checkable.
 *
 * From 29 September 2026 the entry that attests the work's novelty also
 * commits it, as `novelty` (the check whose novelty_event_id is this entry's
 * id). Entries that attested nothing carry no such key, so every entry
 * written before the rule recomputes exactly as it always did.
 *
 * From 30 September 2026 a bootstrap arbitration (a UAIN default verifier
 * deciding contested work while the network is in bootstrap, recorded as not
 * independent) commits `bootstrap: true`. Every other check carries no such
 * key, so every earlier entry recomputes exactly as it did.
 */
export const checkCommitment = (v: Row, judgement: Row | null, novelty: Row | null = null): string =>
  tag(`${v.contribution_id} check`, {
    record: 'check', contribution_id: v.contribution_id, verifier: v.verifier,
    verdict: v.verdict, note: v.note, at: v.at, excluded: parsed(v.excluded),
    revised_claim: v.revised_claim ?? null, reproduction_receipt: parsed(v.reproduction_receipt),
    ...(v.bootstrap === true ? { bootstrap: true } : {}),
    judgement: judgement
      ? { revision: judgement.revision, relation: judgement.relation, note: judgement.note, at: judgement.at }
      : null,
    ...(novelty
      ? {
          novelty: {
            novelty: novelty.novelty, checked: parsed(novelty.novelty_checked),
            known_source: novelty.known_source ?? null, note: novelty.novelty_note ?? null,
          },
        }
      : {}),
  });

/**
 * The benevolence class a task or project was opened with (30 September
 * 2026), as declared: { class, statement }. A flag upheld later adds the
 * outcome to the stored value and keeps the declared class as `declared`, so
 * the declaration committed at opening can always be recomputed. Only a
 * declaration carries a statement; anything else commits no `benevolence`
 * key, so every record from before the rule recomputes exactly as it did.
 */
const declaredBenevolence = (stored: unknown): Record<string, unknown> => {
  const b = parsed(stored) as Row | null;
  return b?.statement ? { benevolence: { class: b.declared ?? b.class, statement: b.statement } } : {};
};

/**
 * `T-n`: a task as opened with a prior-art basis (the novelty rule, 29
 * September 2026): the question and why no open-source or discoverable
 * solution to it exists yet. Only fields that never change after opening.
 * From 30 September 2026 also its declared benevolence class. Tasks opened
 * with neither commit nothing.
 */
export const taskCommitment = (t: Row): string =>
  tag(String(t.id), {
    record: 'task', id: t.id, project_id: t.project_id, title: t.title, question: t.question,
    done_when: t.done_when, how_to_check: t.how_to_check, created_by: t.created_by,
    created_at: t.created_at, prior_art: parsed(t.prior_art), ...declaredBenevolence(t.benevolence),
  });

/** `project <id>`: a project as opened with a prior-art basis or a benevolence class, as for a task. */
export const projectCommitment = (p: Row): string =>
  tag(`project ${p.id}`, {
    record: 'project', id: p.id, title: p.title, summary: p.summary, lead: p.lead,
    opened_at: p.opened_at, prior_art: parsed(p.prior_art), ...declaredBenevolence(p.benevolence),
  });

/**
 * `benevolence flag f`: a member's flag that a project, or a task in it, is
 * malevolent (white paper 5.7), with its reason and evidence. task_id is null
 * for a flag on the project itself.
 */
export const benevolenceFlagCommitment = (f: Row): string =>
  tag(`benevolence flag ${f.id}`, {
    record: 'benevolence_flag', flag: f.id, project_id: f.project_id, task_id: f.task_id ?? null,
    flagger: f.flagger, reason: f.reason, evidence: f.evidence, at: f.at,
  });

/** `benevolence flag f decision`: upheld (the target is malevolent) or rejected, by whom, and why. */
export const benevolenceDecisionCommitment = (f: Row): string =>
  tag(`benevolence flag ${f.id} decision`, {
    record: 'benevolence_decision', flag: f.id, project_id: f.project_id, task_id: f.task_id ?? null,
    decided_by: f.decided_by, decision: f.state, note: f.decision_note, at: f.decided_at,
  });

/** `T-n challenge c`: a member's challenge that T-n's answer is already public. */
export const challengeCommitment = (c: Row): string =>
  tag(`${c.task_id} challenge ${c.id}`, {
    record: 'prior_art_challenge', task_id: c.task_id, challenge: c.id, challenger: c.challenger,
    source: c.source, note: c.note, at: c.at,
  });

/** `T-n challenge c decision`: whoever decided it, upheld or rejected, and why. */
export const decisionCommitment = (c: Row): string =>
  tag(`${c.task_id} challenge ${c.id} decision`, {
    record: 'prior_art_decision', task_id: c.task_id, challenge: c.id, decided_by: c.decided_by,
    decision: c.state, note: c.decision_note, at: c.decided_at,
  });

/**
 * `T-n kpi resolution`: how a future-solvable task's KPI resolved (decision D7,
 * 30 September 2026), once per task: met or unmet as a resolver observed it,
 * or expired unresolved. It carries the KPI as resolved and the held work it
 * decided, so the chain fixes what was measured against what, and who paid.
 */
export const kpiResolutionCommitment = (r: Row): string =>
  tag(`${r.task_id} kpi resolution`, {
    record: 'kpi_resolution', task_id: r.task_id, outcome: r.outcome, observed: parsed(r.observed),
    source: r.source ?? null, note: r.note ?? null, resolved_by: r.resolved_by ?? null,
    kpi: parsed(r.kpi), contributions: parsed(r.contributions), at: r.at,
  });

/**
 * `CL-n revision r`: a claim revision, from its stored row. Supporting work is
 * added to a believed revision's sources in place, so each entry that adds
 * one commits the revision again, and only the latest must match it now.
 */
export const revisionCommitment = (r: Row): string =>
  tag(`${r.claim_id} revision ${r.id}`, {
    record: 'claim_revision', claim_id: r.claim_id, revision: r.id, base: r.base ?? null,
    action: r.action, statement: r.statement, sources: parsed(r.sources), reason: r.reason,
    author: r.author, at: r.at,
  });

/** `CL-n revision r review`: one reviewer's verdict on it (the entry's actor). */
export const reviewCommitment = (claimId: string, r: Row): string =>
  tag(`${claimId} revision ${r.revision_id} review`, {
    record: 'claim_review', claim_id: claimId, revision: r.revision_id, reviewer: r.reviewer,
    verdict: r.verdict, note: r.note, at: r.at,
  });

/**
 * `wallet <n>`: a wallet address a member bound to itself (decision D6, 30
 * September 2026), with the challenge that was signed and the signature, so
 * anyone can check the proof from the record. `replaces` is the binding it
 * took the place of, `{ binding, address }`, or null. Only fields that never
 * change once bound; binding n as served at GET /api/wallets/n.
 */
export const walletBindingCommitment = (w: Row): string =>
  tag(`wallet ${w.id}`, {
    record: 'wallet_binding', binding: w.id, member: w.member, chain: w.chain, address: w.address,
    message: w.message, signature: w.signature, bound_by: w.bound_by, bound_at: w.bound_at,
    replaces: w.replaces ?? null,
  });

/** `wallet <n> unbind`: that binding removed by an agent of its member. */
export const walletUnbindingCommitment = (w: Row): string =>
  tag(`wallet ${w.id} unbind`, {
    record: 'wallet_unbinding', binding: w.id, member: w.member, chain: w.chain, address: w.address,
    unbound_by: w.unbound_by, unbound_at: w.unbound_at,
  });
