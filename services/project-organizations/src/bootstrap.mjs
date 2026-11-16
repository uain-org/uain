/** Guardian bootstrap of the native projects `P-<catalogue ID>` for the frozen selection.
 *
 * `open_project` is not a typed central command (apps/baink/server/central-earning-command.mjs
 * is left unchanged), so this module carries its own strictly typed payload, signing bytes
 * and envelope check, mirroring native exactly:
 *   chain/federation/keeper.go:453-499  open_project {id,title,class,prior_art} (exact fields,
 *     authorization.go:74-103 Decode/exactFields), creator or Karma gate, no existing project
 *   chain/federation/store.go:23-26,136-150  validID, basis(prior_art), allowedClass
 *   chain/federation/authorization.go:168-183  SigningBytes
 *
 * Design resolution 3 (docs/superpowers/specs/2026-11-06-project-organizations-design.md):
 * the existing guardian/creator opens the project and remains lead; the per-project
 * manager is designated by central_project_start and then joins; no lead transfer is
 * inferred; an existing project at the ID is reused only on an exact binding match and
 * otherwise held for reconciliation; ownership is never inferred from a matching name.
 *
 * Title comes only from the catalogue source row whose digest reproduces the frozen
 * selection's pinned source digest. Class and prior art come only from a reviewed
 * bootstrap record bound to the same project and source digest; model output never
 * supplies them. Native has no project description field. */
import { createPublicKey, verify } from 'node:crypto';
import { canonicalJSON, memberAddress } from '../../../apps/baink/server/native-financial-command.mjs';
import { CENTRAL_POLICY } from '../../../apps/baink/server/central-earning-command.mjs';
import { ADDRESS, NATIVE_ID, OrganizationError, canonical, digest, exactKeys, need, plain, refuse } from './common.mjs';
import { sourceDigestOf } from './selection.mjs';

/** ops/custody/native_migration.py GUARDIAN: the fixed production guardian/creator. */
export const GUARDIAN = 'uain158ac8d0debcf01d43164ef14736597da589d8b54';
export const BOOTSTRAP_REVIEW_SCHEMA = 'uain-project-organization-bootstrap-review-v1';
/** Guardian operations reachable only through the bootstrap caller. */
export const BOOTSTRAP_OPERATIONS = Object.freeze(['open_project', 'central_project_start', 'central_fund_configure']);
/** Native order. central_fund_configure needs the budget central_project_start creates
 * (central_fund.go:84-86 centralProject; evaluator != budget.manager), so start precedes it. */
export const BOOTSTRAP_STEPS = Object.freeze(['open_project', 'central_project_start', 'central_fund_configure', 'project_join']);
export const NATIVE_CLASSES = Object.freeze(['benevolent', 'neutral']);
/** Refusals that need review or reconciliation rather than a retry. */
export const BOOTSTRAP_HOLDS = Object.freeze([
  'native_project_conflict', 'native_bootstrap_conflict', 'native_manager_mismatch', 'prior_art_review_required', 'prior_art_review_stale',
  'invalid_prior_art_review', 'title_outside_native_bounds', 'selected_source_changed', 'guardian_not_creator',
  'bootstrap_step_failed',
]);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const bytes = (s) => Buffer.byteLength(s);
/** Native trims with Go strings.TrimSpace. Reviewed text must already be trimmed, so
 * the JS and Go whitespace sets can never disagree about the measured length. */
const reviewedText = (v, min, max, { multiline = false } = {}) => typeof v === 'string' && !LONE_SURROGATE.test(v) &&
  !CONTROL.test(v) && !/\r/.test(v) && (multiline || !/[\n\t]/.test(v)) && v === v.trim() && !/^[\u0085᠎﻿]|[\u0085᠎﻿]$/.test(v) &&
  bytes(v) >= min && bytes(v) <= max;

/** keeper.go:470 title 5..250 bytes; store.go:136-148 basis >= 40 trimmed bytes, <= 4000
 * bytes; 2..20 distinct searches of 5..1000 trimmed bytes; store.go:150 class. */
export function openProjectPayload(value) {
  try {
    need(exactKeys(value, ['id', 'title', 'class', 'prior_art']) && exactKeys(value.prior_art, ['basis', 'searches']), 'invalid_native_payload');
    const { id, title, prior_art: art } = value;
    need(typeof id === 'string' && NATIVE_ID.test(id), 'invalid_native_payload');
    need(reviewedText(title, 5, 250), 'invalid_native_payload');
    need(NATIVE_CLASSES.includes(value.class), 'invalid_native_payload');
    need(reviewedText(art.basis, 40, 4000, { multiline: true }), 'invalid_native_payload');
    need(Array.isArray(art.searches) && art.searches.length >= 2 && art.searches.length <= 20, 'invalid_native_payload');
    need(art.searches.every((q) => reviewedText(q, 5, 1000)) && new Set(art.searches).size === art.searches.length, 'invalid_native_payload');
    return Object.freeze({
      id, title, class: value.class,
      prior_art: Object.freeze({ basis: art.basis, searches: Object.freeze([...art.searches]) }),
    });
  } catch (error) {
    if (error instanceof OrganizationError) throw error;
    refuse('invalid_native_payload');
  }
}

const COMMAND_ORDER = ['version', 'chain_id', 'member', 'sequence', 'expires_height', 'operation', 'payload'];
/** The same bytes as native SigningBytes for an open_project command. */
export function openProjectSigningBytes(command) {
  need(exactKeys(command, COMMAND_ORDER) && command.version === 1 && command.operation === 'open_project', 'invalid_native_command');
  need(typeof command.chain_id === 'string' && /^[A-Za-z0-9._-]{1,96}$/.test(command.chain_id), 'invalid_native_command');
  need(typeof command.member === 'string' && ADDRESS.test(command.member), 'invalid_native_command');
  need(typeof command.sequence === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(command.sequence) && BigInt(command.sequence) < 18446744073709551615n, 'invalid_native_command');
  need(typeof command.expires_height === 'string' && /^[1-9][0-9]{0,18}$/.test(command.expires_height) && BigInt(command.expires_height) <= 9223372036854775807n, 'invalid_native_command');
  const validated = { ...command, payload: openProjectPayload(command.payload) };
  const raw = 'uain:chain-command:v1\n{' + COMMAND_ORDER.map((k) => canonicalJSON(k) + ':' + canonicalJSON(validated[k])).join(',') + '}';
  return Buffer.from(raw);
}

/** Real Ed25519 check of an open_project envelope bound to its member address. */
export function verifyOpenProjectEnvelope(envelope, { chainId }) {
  need(exactKeys(envelope, ['command', 'public_key', 'signature']) && envelope.command?.chain_id === chainId, 'custody_envelope_mismatch');
  const signed = openProjectSigningBytes(envelope.command);
  need(typeof envelope.public_key === 'string' && typeof envelope.signature === 'string', 'custody_envelope_mismatch');
  const pub = Buffer.from(envelope.public_key, 'base64url');
  const sig = Buffer.from(envelope.signature, 'base64url');
  need(pub.length === 32 && pub.toString('base64url') === envelope.public_key && sig.length === 64 &&
    sig.toString('base64url') === envelope.signature && memberAddress(pub) === envelope.command.member, 'custody_envelope_mismatch');
  need(verify(null, signed, createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: envelope.public_key } }), sig), 'custody_envelope_mismatch');
  return true;
}

/** Validates a reviewed bootstrap record (class + prior art) for one selected project. */
export function validateBootstrapReview(review, project) {
  need(review !== null && review !== undefined, 'prior_art_review_required', `${project.id} has no reviewed prior-art record`);
  need(exactKeys(review, ['schema', 'project', 'source_digest', 'class', 'prior_art']) && review.schema === BOOTSTRAP_REVIEW_SCHEMA, 'invalid_prior_art_review');
  need(review.project === project.id, 'invalid_prior_art_review', 'review is bound to another project');
  need(review.source_digest === project.sourceDigest, 'prior_art_review_stale', `${project.id} review predates the pinned source`);
  return review;
}

/** Native payload from the frozen selection, its catalogue source row and the review. */
export function buildOpenProjectPayload({ selection, projectId, source, review }) {
  const project = selection.get(projectId);
  need(plain(source) && plain(source.row) && source.row.id === project.id, 'selected_source_changed');
  let pinned;
  try {
    pinned = sourceDigestOf(source.row, source.revision);
  } catch {
    refuse('selected_source_changed');
  }
  need(pinned === project.sourceDigest, 'selected_source_changed', `${project.id} catalogue source does not reproduce its pin`);
  const title = source.row.title;
  // Never padded, truncated or rewritten: a title native refuses is held.
  need(reviewedText(title, 5, 250), 'title_outside_native_bounds', `${project.id} title does not fit native bounds`);
  validateBootstrapReview(review, project);
  try {
    return openProjectPayload({ id: project.nativeProjectId, title, class: review.class, prior_art: review.prior_art });
  } catch {
    refuse('invalid_prior_art_review');
  }
}

/** Native compact storage (chain/federation/compact.go createProject, `compact-state-v1`, active
 * on production and in every native fixture) moves title, class and prior art out of
 * `project/<id>` into the immutable `project_metadata/<id>` record and leaves them empty in
 * the state record. The reader proves both keys at one height; this reassembles the project
 * exactly as native's `Keeper.Project` does, or returns null when the metadata is missing. */
export function projectWithMetadata(existing, metadata) {
  if (!plain(existing)) return null;
  if (existing.storage_policy === undefined && existing.metadata_digest === undefined) return existing;
  if (existing.storage_policy !== 'compact-state-v1' || typeof existing.metadata_digest !== 'string') return null;
  if (!exactKeys(metadata, ['id', 'title', 'class', 'prior_art']) || metadata.id !== existing.id) return null;
  if (existing.title !== '' || existing.class !== '') return null;
  return { ...existing, title: metadata.title, class: metadata.class, prior_art: metadata.prior_art };
}

/** An existing native project is this project only if every bound field matches. */
export function projectBindingMatches(existing, payload, guardian, metadata = null) {
  const full = projectWithMetadata(existing, metadata);
  return plain(full) && full.id === payload.id && full.lead === guardian && full.title === payload.title &&
    full.class === payload.class && plain(full.prior_art) && canonical(full.prior_art) === canonical(payload.prior_art) &&
    full.state === 'active' && full.safety_halted === false && !full.lead_instance;
}

export const participationKey = (nativeProjectId, member) => `participation/${nativeProjectId}/${member}/`;
const height = (v) => (typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) ? BigInt(v) : null);
const active = (m) => plain(m) && m.licence === 'active';

/** Fresh native prerequisites for one guardian bootstrap step, from reader records
 * (keys: project, project metadata, budget, fund config, central activation, manager, evaluator).
 * Returns { reused } when native already holds exactly the intended state. */
export function checkBootstrapState({ operation, payload, bound, guardian, member, records, stateHeight }) {
  const P = bound.native_project;
  need(plain(member) && member.id === guardian && member.licence === 'active', 'member_licence_inactive');
  const project = records[`project/${P}`] ?? null;
  const budget = records[`central_project_budget/${P}`] ?? null;
  const config = records[`central_fund_config/${P}`] ?? null;
  if (operation === 'open_project') {
    if (project !== null) {
      need(projectBindingMatches(project, payload, guardian, records[`project_metadata/${P}`] ?? null), 'native_project_conflict', `${P} exists and is not this exact binding`);
      return { reused: true };
    }
    need(member.creator === true, 'guardian_not_creator');
    return { reused: false };
  }
  need(plain(project) && project.id === P, 'native_project_missing');
  need(project.lead === guardian && !project.lead_instance, 'native_project_conflict', `${P} lead is not the guardian`);
  need(project.state === 'active' && project.safety_halted === false, 'native_project_inactive');
  const activation = records.central_earning_activation ?? null;
  const live = () => need(plain(activation) && activation.policy === CENTRAL_POLICY && height(activation.height) !== null &&
    height(activation.height) <= BigInt(stateHeight), 'central_earning_inactive');
  if (operation === 'central_project_start') {
    if (budget !== null) {
      need(plain(budget) && budget.project === P && budget.manager === bound.manager, 'native_bootstrap_conflict', `${P} budget names another manager`);
      return { reused: true };
    }
    live();
    need(active(records[`member/${bound.manager}`]), 'manager_licence_inactive');
    return { reused: false };
  }
  need(operation === 'central_fund_configure', 'bootstrap_is_guardian_only');
  need(plain(budget) && budget.project === P && budget.closed !== true, 'native_budget_unavailable');
  need(budget.manager === bound.manager, 'native_manager_mismatch');
  if (config !== null) {
    need(plain(config) && config.project === P && config.evaluator === bound.evaluator, 'native_bootstrap_conflict', `${P} has another evaluator`);
    return { reused: true };
  }
  live();
  need(bound.evaluator !== budget.manager, 'evaluator_is_manager');
  need(active(records[`member/${bound.evaluator}`]), 'evaluator_licence_inactive');
  return { reused: false };
}

/**
 * Orchestrates one project's bootstrap: open_project -> central_project_start ->
 * central_fund_configure (guardian, caller 'bootstrap') -> project_join (bound manager).
 * Each step is prepared only after the previous one is confirmed in the journal or
 * proven already satisfied by fresh native state. It never dispatches or reconciles;
 * it returns the step it is waiting on.
 *
 * @param source(projectId) -> {row, revision} live catalogue record
 * @param review(projectId) -> reviewed bootstrap record or null
 */
export function createBootstrap({ adapter, journal, selection, policy, source, review }) {
  need(typeof adapter?.prepare === 'function' && typeof journal?.get === 'function' && selection &&
    typeof source === 'function' && typeof review === 'function', 'invalid_bootstrap_configuration');
  const currentPolicy = () => (typeof policy === 'function' ? policy() : policy);
  const intentId = (projectId, n, operation) => `bootstrap-${projectId}-${n + 1}-${operation}`;

  async function bootstrapProject(projectId) {
    const project = selection.get(projectId);
    const bound = currentPolicy()?.projects?.[project.id];
    need(bound, 'project_not_in_fleet_policy');
    const P = project.nativeProjectId;
    const completed = [];
    const result = (status, step, extra = {}) => Object.freeze({ status, projectId: project.id, step, completed: Object.freeze([...completed]), ...extra });
    let record;
    let evidence;
    for (const [n, operation] of BOOTSTRAP_STEPS.entries()) {
      const id = intentId(project.id, n, operation);
      const existing = journal.get(id);
      if (existing?.state === 'confirmed') {
        completed.push({ step: operation, via: 'journal', intentId: id });
        continue;
      }
      if (existing && existing.state !== 'failed') return result('waiting', operation, { intentId: id, intentState: existing.state });
      if (existing && existing.failure !== 'native_already_satisfied')
        return result('held', operation, { reason: 'bootstrap_step_failed', failure: existing.failure, intentId: id });
      try {
        if (record === undefined) {
          record = await review(project.id);
          validateBootstrapReview(record, project);
          evidence = digest(record);
        }
        let payload;
        let options;
        if (operation === 'open_project') {
          payload = buildOpenProjectPayload({ selection, projectId: project.id, source: await source(project.id), review: record });
          options = { caller: 'bootstrap' };
        } else if (operation === 'central_project_start') {
          payload = { project: P, manager: bound.manager, evidence_digest: evidence };
          options = { caller: 'bootstrap' };
        } else if (operation === 'central_fund_configure') {
          payload = { project: P, evaluator: bound.evaluator, expected_evaluator: '', evidence_digest: evidence };
          options = { caller: 'bootstrap' };
        } else {
          payload = { project: P };
          options = { caller: 'agent', signer: bound.manager };
        }
        const prepared = await adapter.prepare(project.id, operation, payload, { id, ...options });
        if (prepared.state === 'reused') {
          completed.push({ step: operation, via: 'native', height: prepared.height });
          continue;
        }
        if (prepared.state === 'failed') return result('held', operation, { reason: 'bootstrap_step_failed', failure: prepared.failure, intentId: id });
        return result('waiting', operation, { intentId: prepared.id, intentState: prepared.state });
      } catch (error) {
        if (!(error instanceof OrganizationError)) throw error;
        return result(BOOTSTRAP_HOLDS.includes(error.code) ? 'held' : 'blocked', operation, { reason: error.code });
      }
    }
    return result('complete', null);
  }

  return { bootstrapProject, intentId };
}
