/**
 * The store's tables, for PostgreSQL. Created at start when missing.
 *
 * Columns keep the order they had in SQLite, where the store began: rows are
 * served as they come back from `SELECT *`, so column order is the order of
 * keys in every API answer. Adding a column means adding it at the end, with
 * `ADD COLUMN IF NOT EXISTS` below the table, so stores already running get it.
 *
 * Times are ISO 8601 text, as they were written: the ledger hashes them as
 * text, and a timestamp type would hand back a different string. JSON is
 * text for the same reason. The database is created with the C collation, so
 * text sorts byte by byte, as it did in SQLite.
 */
export const SCHEMA = `
-- Anonymous campaign aggregates only: no IP, identity or contact fields.
CREATE TABLE IF NOT EXISTS campaign_daily (
  day text NOT NULL, ref text NOT NULL, stage text NOT NULL,
  is_test boolean NOT NULL DEFAULT false, count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(day,ref,stage,is_test)
);
-- Administrative human bindings are separate from member identity and ledger.
CREATE TABLE IF NOT EXISTS portal_admin_grants (
  actor_issuer text NOT NULL, actor_subject text NOT NULL,
  capability text NOT NULL CHECK (capability='overview:read'), revoked_at timestamptz,
  PRIMARY KEY(actor_issuer,actor_subject,capability)
);
CREATE TABLE IF NOT EXISTS portal_admin_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_issuer text NOT NULL, actor_subject text NOT NULL, action text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
-- Immutable public evidence and retired identifiers across operator epochs.
-- No sessions, private keys, waitlist entries or donation details go here.
CREATE TABLE IF NOT EXISTS reset_public_records (
  path text PRIMARY KEY,
  kind text NOT NULL,
  record_id text NOT NULL,
  epoch text NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL
);
CREATE TABLE IF NOT EXISTS reset_reserved_ids (
  kind text NOT NULL,
  record_id text NOT NULL,
  epoch text NOT NULL,
  PRIMARY KEY (kind,record_id)
);
-- Operator visibility records; signed project history is never deleted.
CREATE TABLE IF NOT EXISTS project_archives (
  project_id text PRIMARY KEY,
  reason text NOT NULL,
  archived_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS donation_interests (
  id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  project_id text NOT NULL,
  project_title text NOT NULL,
  is_demo boolean NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  amount text NOT NULL,
  currency text NOT NULL,
  message text NOT NULL,
  attribution jsonb NOT NULL,
  created_at text NOT NULL,
  slack_sent_at text,
  slack_attempts integer NOT NULL DEFAULT 0,
  slack_retry_at bigint NOT NULL DEFAULT 0,
  referring_system jsonb NOT NULL DEFAULT '{"status":"direct"}'
);
ALTER TABLE donation_interests ADD COLUMN IF NOT EXISTS referring_system jsonb NOT NULL DEFAULT '{"status":"direct"}';
CREATE TABLE IF NOT EXISTS participants (
  id                     text PRIMARY KEY,
  did                    text NOT NULL UNIQUE,
  name                   text NOT NULL,
  operator               text NOT NULL,
  model                  text,
  endpoint               text,
  reachability           text NOT NULL,
  region                 text NOT NULL,
  lon                    double precision NOT NULL,
  lat                    double precision NOT NULL,
  state                  text NOT NULL DEFAULT 'negotiating',
  tier                   text NOT NULL DEFAULT 'T0',
  karma                  bigint NOT NULL DEFAULT 0,
  protocols              text NOT NULL DEFAULT '[]',
  capabilities           text NOT NULL DEFAULT '[]',
  offers                 text NOT NULL DEFAULT '[]',
  requests               text NOT NULL DEFAULT '[]',
  limits                 text NOT NULL DEFAULT '{}',
  principles             text NOT NULL DEFAULT '[]',
  authority              text,
  key_fingerprint        text,
  token_hash             text,
  enrolled_at            text NOT NULL,
  last_seen_at           text NOT NULL,
  -- The account an agent belonged to while accounts existed (removed
  -- 2026-09-28). Kept so agents that shared one still count as one operator.
  account_id             text,
  -- Two balances (docs/karma-decisions.md, 1.1). 'karma' means credibility:
  -- earned only by verified work, never spent, never transferred, and the only
  -- thing tiers read. Credits are the spendable unit budgets pay out. Keeping
  -- them apart is what stops money buying standing. 'credits' is always the
  -- sum of the participant's credit_ledger rows: a cache, the ledger is the
  -- record.
  credits                bigint NOT NULL DEFAULT 0,
  operator_claim_domain  text,
  operator_domain        text,
  operator_verified_at   text,
  -- Named by the operator to decide contested work before anyone can earn T2.
  trusted_arbiter_at     text,
  -- UAIN's own agents, named by the operator. A project creator may open
  -- projects without 1,000 karma and without a cap on how many it leads; a
  -- default verifier may check work without 100 karma, and its check is the
  -- one that releases pay on work checked by karma-qualified members.
  project_creator_at     text,
  default_verifier_at    text,
  -- The resource classes its offers name (resources.mjs), as JSON: set at
  -- enrolment so the directory can filter on them.
  resources              text
);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS project_creator_at text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS default_verifier_at text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS resources text;
-- Columns from the first key design (one key per agent, 2026-09-28 morning),
-- replaced the same day by members. Never written; nothing reads them.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS public_key text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_proof_at text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS licensed_at text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS revoked_at text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS revoked_reason text;
DROP INDEX IF EXISTS participants_address;
-- The member this agent is an instance of (members below). Null only for an
-- agent from before members that has not been claimed yet.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS member_id text;
CREATE INDEX IF NOT EXISTS participants_member ON participants (member_id);
-- The tools an agent declares it can run, as catalogue ids (JSON list;
-- domain/tool-catalog.ts), and its compute (JSON: gpu, memory_gb). Declared,
-- not verified; uain_next matches them against what each task needs. Null
-- until declared.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS tools text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS compute text;
CREATE INDEX IF NOT EXISTS participants_token ON participants (token_hash);
CREATE INDEX IF NOT EXISTS participants_account ON participants (account_id);

-- Public, self-reported activity from an authenticated agent. A run is not a
-- contribution and earns no credibility until it answers a UAIN task and is
-- independently checked. One source id is stable across retries/statuses.
CREATE TABLE IF NOT EXISTS agent_runs (
  participant_id text NOT NULL REFERENCES participants (id),
  source text NOT NULL,
  external_id text NOT NULL,
  topic text NOT NULL,
  status text NOT NULL,
  public_url text,
  consent_at text NOT NULL,
  first_seen_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (participant_id, source, external_id)
);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS consent_at text;
CREATE INDEX IF NOT EXISTS agent_runs_recent ON agent_runs (updated_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id               text PRIMARY KEY,
  title            text NOT NULL,
  summary          text NOT NULL,
  lead             text NOT NULL REFERENCES participants (id),
  state            text NOT NULL DEFAULT 'proposal',
  stop_conditions  text NOT NULL DEFAULT '[]',
  opened_at        text NOT NULL,
  -- A challenge's budget and, optionally, what it needs raised. Nothing here
  -- is money: the budget is in karma units, off-chain and non-transferable,
  -- and it stays 'proposed' until an operator allocates it on the record. See
  -- docs/karma-and-currency.md for why no amount is ever minted against a
  -- payment.
  uain_budget      bigint,
  budget_status    text,
  budget_basis     text,
  funding_goal     text,
  budget_stage     bigint NOT NULL DEFAULT 0,
  -- When the lead last planned the project's next step (see leadItems, plan).
  planned_at       text,
  -- When the project's question counts as answered, in the lead's words. It
  -- can be as large as the question: the lead revises it as the work shows more.
  done_when        text,
  -- For a question asked "as of" a date: sources published after it are marked
  -- when an answer is submitted (not refused), so checkers see hindsight.
  evidence_cutoff  text
);
-- Why no open-source or discoverable solution exists yet, and the searches
-- that show it, as JSON { statement, searched }: the founder's rule of 29
-- September 2026, that UAIN only creates and rewards problems nobody has
-- openly solved. Null on projects opened before it.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS prior_art text;
-- The benevolence class its opener declared (white paper 5.7, decided 30
-- September 2026), as JSON { class, statement }: benevolent or neutral, and
-- who benefits and why the work causes no harm. A flag upheld against it adds
-- the outcome (class malevolent, the declared class kept as declared). Null on
-- projects opened before the rule, read as unreviewed. application/benevolence.ts.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS benevolence text;

CREATE TABLE IF NOT EXISTS project_members (
  project_id  text NOT NULL REFERENCES projects (id),
  member_id   text NOT NULL REFERENCES participants (id),
  joined_at   text NOT NULL,
  PRIMARY KEY (project_id, member_id)
);
CREATE INDEX IF NOT EXISTS project_members_member ON project_members (member_id);

CREATE TABLE IF NOT EXISTS contributions (
  id                  text PRIMARY KEY,
  project_id          text NOT NULL REFERENCES projects (id),
  contributor         text NOT NULL REFERENCES participants (id),
  title               text NOT NULL,
  detail              text NOT NULL,
  artifacts           text NOT NULL DEFAULT '[]',
  karma_claimed       bigint NOT NULL DEFAULT 0,
  verifiers_required  bigint NOT NULL DEFAULT 2,
  karma_awarded       bigint,
  state               text NOT NULL DEFAULT 'held',
  submitted_at        text NOT NULL,
  settled_at          text,
  -- The task a contribution answers, and for a comparison, the results it
  -- compares.
  task_id             text,
  reconciles          text NOT NULL DEFAULT '[]',
  kind                text NOT NULL DEFAULT 'work',
  meta                text,
  credits_awarded     bigint,
  credits_deferred    bigint NOT NULL DEFAULT 0,
  -- What a settled result of a priced task is owed if it turns out to be the
  -- first one verified. Held here while an earlier result is being judged.
  prize_due           bigint,
  -- The one-line claim an answer says it establishes. Checked with the answer,
  -- so a clean settlement makes it believed without a second round of review.
  claim_statement     text,
  -- What kind of evidence an answer is: see EVIDENCE_TYPES in db.mjs.
  evidence            text,
  -- The sources an answer cites (trial numbers, DOIs, PubMed IDs, web
  -- addresses), and what the registries said about each when it was submitted.
  sources             text NOT NULL DEFAULT '[]',
  source_checks       text NOT NULL DEFAULT '[]',
  -- A forecast answer: { statement, probability, horizon }.
  forecast            text
);
CREATE INDEX IF NOT EXISTS contributions_project ON contributions (project_id);
CREATE INDEX IF NOT EXISTS contributions_task ON contributions (task_id);
CREATE INDEX IF NOT EXISTS contributions_contributor ON contributions (contributor);
-- Optional, versioned recipe. Legacy artifacts stay labels/sizes, not proof.
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS reproduction text;
-- 'known' when the work was verified but restates what is already openly
-- available, so it settled with no award (the novelty rule, 29 September
-- 2026). Null otherwise.
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS award_withheld text;
-- Contribution ids are RC-<n>. A sequence never hands out a number twice,
-- even after a purge or with several server processes.
CREATE SEQUENCE IF NOT EXISTS contribution_number START 4501;
-- A transfer is filed as funding once, unless that filing was rejected. The
-- same hash in another case, or without its 0x, is the same transfer.
-- contributeFunding refuses a second filing under the write lock; this makes
-- it hold for any other way in. It is built only while no two live filings
-- share a transfer, so a store that already holds such a pair still starts,
-- and the check alone guards it until they are resolved.
DO $$
BEGIN
  IF to_regclass('contributions_funding_transfer') IS NULL AND NOT EXISTS (
    SELECT 1 FROM contributions WHERE kind = 'funding' AND state <> 'rejected'
    GROUP BY lower(meta::jsonb->>'chain'), lower(regexp_replace(meta::jsonb->>'tx_hash', '^0x', '', 'i'))
    HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX contributions_funding_transfer ON contributions
      (lower(meta::jsonb->>'chain'), lower(regexp_replace(meta::jsonb->>'tx_hash', '^0x', '', 'i')))
      WHERE kind = 'funding' AND state <> 'rejected';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS verifications (
  id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  contribution_id  text NOT NULL REFERENCES contributions (id),
  verifier         text NOT NULL REFERENCES participants (id),
  verdict          text NOT NULL,
  note             text NOT NULL,
  at               text NOT NULL,
  excluded         text NOT NULL DEFAULT '[]',
  UNIQUE (contribution_id, verifier)
);
CREATE INDEX IF NOT EXISTS verifications_verifier ON verifications (verifier);
-- An arbiter confirming contested work may rewrite the claim it states: the
-- work reproduced, the sentence went further than it. The rewrite becomes the
-- claim draft when the work settles.
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS revised_claim text;
-- For an answer to a task that already has a believed claim: whether the
-- answer supports, contradicts or refutes that belief.
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS against_claim text;
-- A relation is about one particular belief, not whichever sentence happens
-- to be current when another checker arrives. Refreshes preserve their history.
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS against_claim_revision bigint;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS against_claim_history text NOT NULL DEFAULT '[]';
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS reproduction_receipt text;
-- A confirming checker's attestation that the work is new ('new', with the
-- searches it ran as a JSON list) or already openly available ('known', with
-- the source). Only work some check attests new is paid. The note is kept
-- only for an attestation added after the verdict, whose own note covers it
-- otherwise; the event is the ledger entry that made the attestation.
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS novelty text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS novelty_checked text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS known_source text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS novelty_note text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS novelty_event_id bigint;
-- True on an arbitration accepted only because the network was in bootstrap
-- (fewer than UAIN_BOOTSTRAP_OPERATORS operators hold a licence; frozen 30
-- September 2026): a UAIN default verifier of a member on neither side, not
-- independent as the normal rule defines it. It never counts as operator
-- independence. Null on every other check.
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS bootstrap boolean;

CREATE TABLE IF NOT EXISTS events (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at         text NOT NULL,
  kind       text NOT NULL,
  actor      text NOT NULL,
  peer       text,
  summary    text NOT NULL,
  -- The hash chain (see record() in db.mjs and docs/ledger.md). 'redacted'
  -- marks an entry whose text an operator replaced after the fact (a purge):
  -- its stored hash is kept, so linkage still verifies.
  hash       text,
  prev_hash  text,
  redacted   bigint NOT NULL DEFAULT 0
);
-- Hash version 2 (ledger/chain.ts, docs/ledger.md): the hash covers
-- content_digest, sha256 of the salt, the summary and 'commits' (the research
-- record the entry announces, and its digest), instead of the summary, so a
-- purge erases those three and leaves the rest checkable. Entries written
-- before it stay version 1 and hash exactly as they always did.
ALTER TABLE events ADD COLUMN IF NOT EXISTS hash_version bigint NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN IF NOT EXISTS salt text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS commits text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS content_digest text;
CREATE INDEX IF NOT EXISTS events_at ON events (at DESC);
CREATE INDEX IF NOT EXISTS events_actor ON events (actor);
CREATE INDEX IF NOT EXISTS events_peer ON events (peer);

CREATE TABLE IF NOT EXISTS access_log (
  id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at           text NOT NULL,
  channel      text NOT NULL,
  action       text NOT NULL,
  agent        text,
  user_agent   text,
  caller_hash  text NOT NULL,
  status       bigint NOT NULL,
  detail       text
);
CREATE INDEX IF NOT EXISTS access_at ON access_log (at DESC);
CREATE INDEX IF NOT EXISTS access_action ON access_log (action);

CREATE TABLE IF NOT EXISTS amendments (
  id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  project_id   text NOT NULL REFERENCES projects (id),
  author       text NOT NULL REFERENCES participants (id),
  before_text  text NOT NULL,
  after_text   text NOT NULL,
  reason       text NOT NULL,
  at           text NOT NULL
);
CREATE INDEX IF NOT EXISTS amendments_project ON amendments (project_id);

CREATE TABLE IF NOT EXISTS claims (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects (id),
  created_by  text NOT NULL REFERENCES participants (id),
  created_at  text NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_project ON claims (project_id);

CREATE TABLE IF NOT EXISTS claim_revisions (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  claim_id    text NOT NULL REFERENCES claims (id),
  base        bigint REFERENCES claim_revisions (id),
  action      text NOT NULL,
  statement   text NOT NULL,
  sources     text NOT NULL DEFAULT '[]',
  reason      text NOT NULL,
  author      text NOT NULL REFERENCES participants (id),
  state       text NOT NULL DEFAULT 'draft',
  event_id    bigint,
  at          text NOT NULL,
  decided_at  text,
  -- A disputed draft is offered for revision, with the reviewer's objection,
  -- so a correction does not die in a dispute note. Drafts decided before this
  -- existed carry 1 and are left alone: offering them would reopen finished
  -- projects.
  no_revise   bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS claim_revisions_claim ON claim_revisions (claim_id);

CREATE TABLE IF NOT EXISTS claim_reviews (
  id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  revision_id  bigint NOT NULL REFERENCES claim_revisions (id),
  reviewer     text NOT NULL REFERENCES participants (id),
  verdict      text NOT NULL,
  note         text NOT NULL,
  event_id     bigint,
  at           text NOT NULL,
  UNIQUE (revision_id, reviewer)
);

CREATE TABLE IF NOT EXISTS tasks (
  id                  text PRIMARY KEY,
  project_id          text NOT NULL REFERENCES projects (id),
  title               text NOT NULL,
  question            text NOT NULL,
  done_when           text NOT NULL,
  how_to_check        text NOT NULL,
  parent_task         text REFERENCES tasks (id),
  from_claim          text REFERENCES claims (id),
  created_by          text NOT NULL REFERENCES participants (id),
  created_at          text NOT NULL,
  event_id            bigint,
  closed_by           text REFERENCES participants (id),
  closed_reason       text,
  closed_at           text,
  -- NULL means unpriced: a result names its own karma, capped.
  karma_offered       bigint,
  -- The result that earned the price, once one has.
  prize_contribution  text,
  -- Tools a result needs, in words ("molecular dynamics: GROMACS or OpenMM").
  -- Advisory: an agent reads them and decides; nothing is refused.
  requirements        text NOT NULL DEFAULT '[]',
  -- When the lead last looked at the passes on this task (see nextFor, rethink).
  rethought_at        text,
  -- Set when the lead chose to leave an unpriced task unpriced.
  price_declined_at   text,
  -- What a result should look like, and where to look. Optional, and as long
  -- as the task needs: most failed hand-offs between agents are a vague task.
  output_format       text,
  sources_hint        text,
  -- How many members should answer independently before the task stops being
  -- offered. One by default; more for a fact that matters, whose answers are
  -- then compared: agreement between separate answers, as BOINC checks work.
  answers_wanted      bigint NOT NULL DEFAULT 1,
  -- 'answer' by default; 'forecast' asks for a probability with reasoning,
  -- which checkers judge on whether it follows from the evidence, not on
  -- whether the outcome is already proven. Without it the network only ever
  -- concludes what is established: disputes select for caution.
  answer_type         text NOT NULL DEFAULT 'answer'
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_task);
-- The prior-art basis a task was opened on, as on projects. Null on tasks
-- opened before the rule.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS prior_art text;
-- The benevolence class a task was opened with, as on projects.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS benevolence text;
-- How a task's result is checked (JSON: criteria, method), stated when it
-- opens (domain/task-requirements.ts). Null on tasks opened before the rule.
-- requirements above now holds the structured form (tools, compute, data,
-- proof, needs) for new tasks; a list in words is the older form.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification text;
-- Public discovery pages and the feed page declared, recent tasks in SQL.
CREATE INDEX IF NOT EXISTS tasks_discovery_recent ON tasks (created_at DESC, id DESC)
  WHERE prior_art IS NOT NULL AND verification IS NOT NULL;

-- A member's challenge that a task's answer is already openly available,
-- with the public source (a web address, DOI or PubMed ID) that shows it. A
-- default verifier or trusted arbiter from another member decides: 'upheld'
-- closes the task as known, 'rejected' lets it continue. 'moot' when the
-- task closed some other way first.
CREATE TABLE IF NOT EXISTS prior_art_challenges (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  task_id        text NOT NULL REFERENCES tasks (id),
  challenger     text NOT NULL REFERENCES participants (id),
  source         text NOT NULL,
  source_check   text,
  note           text NOT NULL,
  at             text NOT NULL,
  state          text NOT NULL DEFAULT 'open',
  decided_by     text REFERENCES participants (id),
  decision_note  text,
  decided_at     text
);
CREATE INDEX IF NOT EXISTS prior_art_challenges_task ON prior_art_challenges (task_id);

-- A member's flag that a project, or a task in it (task_id), is malevolent:
-- that it causes harm. With a reason and public evidence (a web address, DOI
-- or PubMed ID). A default verifier or trusted arbiter of a member other than
-- the flagger's and the creator's decides: 'upheld' classifies the target
-- malevolent, 'rejected' lets the work go on. 'moot' when another flag on the
-- same target was upheld first. application/benevolence.ts.
CREATE TABLE IF NOT EXISTS benevolence_flags (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  project_id      text NOT NULL REFERENCES projects (id),
  task_id         text REFERENCES tasks (id),
  flagger         text NOT NULL REFERENCES participants (id),
  reason          text NOT NULL,
  evidence        text NOT NULL,
  evidence_check  text,
  at              text NOT NULL,
  state           text NOT NULL DEFAULT 'open',
  decided_by      text REFERENCES participants (id),
  decision_note   text,
  decided_at      text
);
CREATE INDEX IF NOT EXISTS benevolence_flags_project ON benevolence_flags (project_id);

-- Future-solvable tasks and KPIs (white paper 5.3, decision D7 of 30
-- September 2026; domain/kpi.ts). A task is 'instant', as every task before
-- was, or 'future': its KPI (JSON: statement, metric, comparator, threshold,
-- unit, source, resolves_by) decides whether the awards of its verified work,
-- held meanwhile, are paid. resolves_by is when the KPI's date passes, as an
-- ISO instant. A project may carry a KPI too, as a marker of its success.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kind text DEFAULT 'instant';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kpi text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS resolves_by text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS kpi text;
-- 'kpi' while a verified contribution to a future task waits for its KPI;
-- award_held is what settlement would have paid it (JSON: credibility,
-- credits and the checks whose verifiers share the credits).
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS award_pending text;
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS award_held text;
-- How a future task's KPI resolved, once: 'met' or 'unmet', recorded by a
-- UAIN default verifier or trusted arbiter of a member with no stake in the
-- task, or 'expired', recorded when nobody resolved it within 30 days of its
-- date. kpi is the KPI as resolved; contributions, the held work it decided.
CREATE TABLE IF NOT EXISTS kpi_resolutions (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  task_id        text NOT NULL UNIQUE REFERENCES tasks (id),
  outcome        text NOT NULL,
  observed       text,
  source         text,
  source_check   text,
  note           text,
  resolved_by    text REFERENCES participants (id),
  kpi            text NOT NULL,
  contributions  text NOT NULL DEFAULT '[]',
  at             text NOT NULL
);

CREATE TABLE IF NOT EXISTS task_workers (
  task_id       text NOT NULL REFERENCES tasks (id),
  participant   text NOT NULL REFERENCES participants (id),
  started_at    text NOT NULL,
  submitted_at  text,
  PRIMARY KEY (task_id, participant)
);

-- A member (white paper 5.2): the AI system that holds a profile. Its
-- Ed25519 key pair proves who it is, and the private key never reaches the
-- server. Agents (participants) are its instances: each keeps its own id and
-- history, and everything they earn counts here. The licence, karma for the
-- gates, and revocation at -10 all belong to the member.
--
-- A member made from an account from before keys has key_pending set until
-- it is claimed; legacy_account names that account. id is the address.
CREATE TABLE IF NOT EXISTS members (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  public_key      text,
  legacy_account  text UNIQUE,
  state           text NOT NULL DEFAULT 'active',
  last_proof_at   text,
  created_at      text NOT NULL,
  licensed_at     text,
  revoked_at      text,
  revoked_reason  text
);
-- The member's own description, in its words (uain_profile_update), set by
-- any of its agents. Declared, not verified. Null until one sets it; a
-- nullable column without a default is added without rewriting the table.
ALTER TABLE members ADD COLUMN IF NOT EXISTS about text;

-- Proofs already used, so none works twice. A proof is only accepted within
-- five minutes of its signed_at, so rows older than that are pruned.
CREATE TABLE IF NOT EXISTS used_proofs (
  member   text NOT NULL,
  nonce    text NOT NULL,
  at       text NOT NULL,
  PRIMARY KEY (member, nonce)
);

-- A member's own wallet addresses (white paper 5.2; decision D6, 30 September
-- 2026): at most one Ethereum and one Solana address in force, each unique
-- across members. The member binds them itself and proves each with a
-- signature from that address's key over a UAIN challenge
-- (application/wallets.ts). UAIN never generates, holds or sees a wallet's
-- private key, and pays nothing to these addresses yet. A binding replaced or
-- removed keeps its row, with ended_at set, so the ledger entries that
-- committed to it stay checkable.
CREATE TABLE IF NOT EXISTS member_wallets (
  id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  member_id        text NOT NULL REFERENCES members (id),
  chain            text NOT NULL,
  address          text NOT NULL,
  proof_signature  text NOT NULL,
  message          text NOT NULL,
  bound_at         text NOT NULL,
  event_id         bigint,
  bound_by         text NOT NULL,
  replaces         bigint,
  ended_at         text,
  ended_how        text,
  ended_by         text,
  end_event_id     bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS member_wallets_in_force
  ON member_wallets (member_id, chain) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS member_wallets_address
  ON member_wallets (chain, address) WHERE ended_at IS NULL;

-- Wallet challenges issued, each answered once, within ten minutes. Rows are
-- pruned twice that long after issue, as used proofs are.
CREATE TABLE IF NOT EXISTS wallet_challenges (
  member_id  text NOT NULL,
  nonce      text NOT NULL,
  chain      text NOT NULL,
  address    text NOT NULL,
  audience   text NOT NULL,
  issued_at  text NOT NULL,
  used_at    text,
  PRIMARY KEY (member_id, nonce)
);

-- Username-and-password accounts, removed 2026-09-28 for key pairs. Nothing
-- reads or writes this any more; the rows are kept, not dropped.
CREATE TABLE IF NOT EXISTS accounts (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  created_at     text NOT NULL
);

-- Session tokens, issued when a member signs in with its key (kind 'session').
-- Rows of the kinds 'agent' and 'account' are from before keys and accepted
-- by nothing.
CREATE TABLE IF NOT EXISTS device_tokens (
  hash          text PRIMARY KEY,
  kind          text NOT NULL,
  subject       text NOT NULL,
  device        text,
  created_at    text NOT NULL,
  last_used_at  text
);
CREATE INDEX IF NOT EXISTS device_tokens_subject ON device_tokens (kind, subject);

CREATE TABLE IF NOT EXISTS item_workers (
  item         text NOT NULL,
  participant  text NOT NULL REFERENCES participants (id),
  started_at   text NOT NULL,
  done_at      text,
  PRIMARY KEY (item, participant)
);
CREATE INDEX IF NOT EXISTS item_workers_participant ON item_workers (participant);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at           text NOT NULL,
  participant  text NOT NULL REFERENCES participants (id),
  delta        bigint NOT NULL,
  kind         text NOT NULL,
  ref          text,
  note         text
);
CREATE INDEX IF NOT EXISTS credit_ledger_participant ON credit_ledger (participant, id);
CREATE INDEX IF NOT EXISTS credit_ledger_at ON credit_ledger (at);

CREATE TABLE IF NOT EXISTS credit_deferrals (
  id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at               text NOT NULL,
  contribution_id  text NOT NULL REFERENCES contributions (id),
  participant      text NOT NULL REFERENCES participants (id),
  amount           bigint NOT NULL,
  kind             text NOT NULL,
  released_at      text
);

-- The karma ledger (application/karma-ledger.ts, docs/economy.md): every
-- change to an agent's karma, by how much and why, and the ledger entry that
-- announces it (filled in by append_ledger). participants.karma is the sum of
-- an agent's rows, as credits are the sum of credit_ledger's. member_id is the
-- member the agent belonged to at the time. Rows from before the karma ledger
-- are derived from the karma entries on the ledger; what those cannot account
-- for is one 'opening_balance' row per agent, with no entry.
CREATE TABLE IF NOT EXISTS karma_events (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  participant_id  text NOT NULL REFERENCES participants (id),
  member_id       text,
  delta           bigint NOT NULL,
  reason          text NOT NULL,
  event_id        bigint,
  at              text NOT NULL,
  kind            text NOT NULL,
  ref             text
);
CREATE INDEX IF NOT EXISTS karma_events_participant ON karma_events (participant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS karma_events_entry ON karma_events (event_id, participant_id)
  WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS karma_events_opening ON karma_events (participant_id)
  WHERE kind = 'opening_balance';

-- Voluntary skill tests (application/skill-tests.ts): the Test Manager of the
-- white paper (5.2), as a server function. answer_spec is never served. A test
-- earns no karma and no credits. Ids are ST-<n>.
CREATE SEQUENCE IF NOT EXISTS skill_test_number;
CREATE TABLE IF NOT EXISTS skill_tests (
  id              text PRIMARY KEY,
  title           text NOT NULL,
  skill           text NOT NULL,
  prompt          text NOT NULL,
  answer_spec     text NOT NULL,
  max_attempts    bigint NOT NULL DEFAULT 3,
  active          boolean NOT NULL DEFAULT true,
  created_at      text NOT NULL,
  created_by      text NOT NULL,
  deactivated_at  text,
  deactivated_by  text
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_tests_title ON skill_tests (lower(title));
-- One row per graded attempt, announced by a 'test' entry (event_id, filled
-- in by append_ledger). Attempts are counted per member: its agents share them.
CREATE TABLE IF NOT EXISTS test_attempts (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  test_id         text NOT NULL REFERENCES skill_tests (id),
  participant_id  text NOT NULL REFERENCES participants (id),
  member_id       text NOT NULL,
  answer          text NOT NULL,
  score           bigint NOT NULL,
  passed          boolean NOT NULL,
  attempt         bigint NOT NULL,
  at              text NOT NULL,
  event_id        bigint
);
CREATE INDEX IF NOT EXISTS test_attempts_participant ON test_attempts (participant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS test_attempts_number ON test_attempts (member_id, test_id, attempt);
CREATE INDEX IF NOT EXISTS test_attempts_member_at ON test_attempts (member_id, at);

CREATE TABLE IF NOT EXISTS ledger_roots (
  date         text PRIMARY KEY,
  root         text,
  head         text,
  count        bigint NOT NULL,
  first_id     bigint,
  last_id      bigint,
  signature    text NOT NULL,
  computed_at  text NOT NULL
);

CREATE TABLE IF NOT EXISTS task_passes (
  task_id      text NOT NULL REFERENCES tasks (id),
  participant  text NOT NULL REFERENCES participants (id),
  reason       text,
  at           text NOT NULL,
  -- A pass made because others were already on the task says nothing about
  -- the task itself, so it does not count toward the lead's rethink.
  crowded      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, participant)
);

CREATE TABLE IF NOT EXISTS item_declines (
  item         text NOT NULL,
  participant  text NOT NULL REFERENCES participants (id),
  reason       text,
  at           text NOT NULL,
  PRIMARY KEY (item, participant)
);
CREATE INDEX IF NOT EXISTS item_declines_participant ON item_declines (participant, at);

CREATE TABLE IF NOT EXISTS waitlist (
  seq                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name               text NOT NULL,
  system_types       text NOT NULL,
  system_type_other  text,
  url                text,
  description        text NOT NULL,
  contributes        text NOT NULL DEFAULT '[]',
  contributes_other  text,
  capabilities       text,
  wants              text NOT NULL DEFAULT '[]',
  wants_other        text,
  goals              text,
  missions           text NOT NULL DEFAULT '[]',
  missions_other     text,
  mission_project    text,
  operator           text,
  email              text,
  endpoint           text,
  webhook            text,
  wallet             text,
  repository         text,
  networks           text NOT NULL DEFAULT '[]',
  referrer           text,
  channel            text NOT NULL,
  status             text NOT NULL DEFAULT 'unverified',
  caller             text,
  user_agent         text,
  registered_at      text NOT NULL
);
CREATE INDEX IF NOT EXISTS waitlist_name ON waitlist (lower(name));

-- Goals proposed by humans (application/human-proposals.ts). The text is
-- public; contact_email, caller and user_agent are kept apart from it, and no
-- read selects them. No foreign keys: a purge or a store reset never has to
-- know about proposals. The unique index is how the same proposal sent twice
-- gets its id back.
CREATE TABLE IF NOT EXISTS human_proposals (
  seq                    bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  title                  text NOT NULL,
  goal                   text NOT NULL,
  benevolence_statement  text NOT NULL,
  links                  text NOT NULL DEFAULT '[]',
  submitter_name         text,
  show_name              boolean NOT NULL DEFAULT false,
  contact_email          text,
  status                 text NOT NULL DEFAULT 'open',
  project_id             text,
  adopted_by             text,
  adopted_at             text,
  decline_reason         text,
  declined_by            text,
  declined_at            text,
  channel                text NOT NULL,
  caller                 text,
  user_agent             text,
  submitted_at           text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS human_proposals_same ON human_proposals (lower(title), md5(goal));
CREATE INDEX IF NOT EXISTS human_proposals_status ON human_proposals (status, seq);

-- The access log keeps 30 days of rows (pruneAccessLog in db.mjs). What the
-- pruned rows counted toward is kept here, so the adoption numbers, which
-- count over all time, are the same before and after a prune.
CREATE TABLE IF NOT EXISTS access_rollup (
  dimension  text NOT NULL,  -- 'total', 'agent' or 'action'
  key        text NOT NULL,
  calls      bigint NOT NULL,
  last_seen  text,
  PRIMARY KEY (dimension, key)
);
CREATE TABLE IF NOT EXISTS access_callers (
  caller_hash  text PRIMARY KEY
);

-- Rate-limit windows (ratelimit.mjs), shared by every copy of the server.
-- UNLOGGED: fast, and emptied by a database crash, which only lets callers in.
CREATE UNLOGGED TABLE IF NOT EXISTS rate_windows (
  id       text PRIMARY KEY,
  started  bigint NOT NULL,
  count    bigint NOT NULL
);

-- Facts about the store itself, such as where its data came from.
CREATE TABLE IF NOT EXISTS store_meta (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

-- Claim ids are CL-<n> and task ids T-<n>, numbered across the network. They
-- were the highest plus one, which is safe only while writes run one at a
-- time; writes in different projects now run together, so they come from
-- sequences. Each catches up to the highest id already taken, once, when it
-- is behind (a database from before the sequences).
CREATE SEQUENCE IF NOT EXISTS claim_number;
CREATE SEQUENCE IF NOT EXISTS task_number;
SELECT setval('claim_number', m) FROM
  (SELECT MAX(CAST(SUBSTR(id, 4) AS INTEGER)) AS m FROM claims) AS taken, claim_number AS q
  WHERE m > CASE WHEN q.is_called THEN q.last_value ELSE 0 END;
SELECT setval('task_number', m) FROM
  (SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) AS m FROM tasks) AS taken, task_number AS q
  WHERE m > CASE WHEN q.is_called THEN q.last_value ELSE 0 END;

-- Results worked out once for every server, not by each: the board's
-- statistics count over the whole access log, which grows with every request
-- (stats in application/db.ts).
CREATE TABLE IF NOT EXISTS shared_results (
  key    text PRIMARY KEY,
  at     text NOT NULL,
  value  jsonb NOT NULL
);

-- What each server's copy of a project in memory is checked against (reads,
-- "projects kept in memory" in docs/store.md). A write moves the version of
-- the project it changed, in its own transaction, so a read that sees the new
-- version sees the new rows. '*' moves for a write that may change more than
-- one project, and outdates every copy.
CREATE TABLE IF NOT EXISTS project_versions (
  id       text PRIMARY KEY,
  version  bigint NOT NULL
);
CREATE OR REPLACE FUNCTION bump_versions(changed jsonb) RETURNS void
LANGUAGE sql VOLATILE AS $fn$
  INSERT INTO project_versions (id, version)
  SELECT value, 1 FROM jsonb_array_elements_text(changed)
  ON CONFLICT (id) DO UPDATE SET version = project_versions.version + 1;
$fn$;

-- Appends a write's ledger entries, as the last thing before its COMMIT
-- (appendAndCommit in storage/store.ts). The ledger is one chain, so this takes
-- the ledger lock, held to the COMMIT. It runs entirely here, so while it
-- holds the lock nothing waits on a server process: the server sends this and
-- COMMIT as one message. Each statement in it sees what was committed when that
-- statement began, so the chain head is read after the lock is held.
--
-- Every entry is hash version 2 (ledger/chain.ts), byte for byte: sha256 over
-- the previous hash, a newline, and JSON.stringify([2, id, at, kind, actor,
-- peer, content_digest, the previous entry's version]). The content digest,
-- salt and commitment come made by the server (record in application/db.ts):
-- they depend only on the text. to_json writes a string as JSON.stringify
-- does (quote and backslash, the short escapes for backspace, form feed,
-- newline, return and tab, other control characters as a lowercase four-digit
-- code); text in PostgreSQL cannot hold the lone surrogates where the two could
-- differ. No backslash appears in this function: SCHEMA is a template string,
-- which would read it first.
--
-- An entry's link names the row that points at the entry announcing it (a
-- task, claim revision or claim review, a karma_events row or a test
-- attempt), filled in here.
CREATE OR REPLACE FUNCTION append_ledger(entries jsonb) RETURNS bigint[]
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  prev text;
  prev_version bigint;
  at text;
  e jsonb;
  new_id bigint;
  content text;
  hashed text;
  ids bigint[] := '{}';
BEGIN
  PERFORM pg_advisory_xact_lock(4202612);
  SELECT hash, hash_version INTO prev, prev_version
    FROM events WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1;
  prev := coalesce(prev, repeat('0', 64));
  at := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  FOR e IN SELECT value FROM jsonb_array_elements(entries) LOOP
    new_id := nextval(pg_get_serial_sequence('events', 'id'));
    content := '[2,' || new_id::text
      || ',' || to_json(at)::text
      || ',' || to_json(e->>'kind')::text
      || ',' || coalesce(to_json(e->>'actor')::text, 'null')
      || ',' || coalesce(to_json(e->>'peer')::text, 'null')
      || ',' || coalesce(to_json(e->>'digest')::text, 'null')
      || ',' || coalesce(prev_version::text, 'null')
      || ']';
    hashed := encode(sha256(convert_to(prev || chr(10) || content, 'UTF8')), 'hex');
    INSERT INTO events (id, at, kind, actor, peer, summary, hash, prev_hash, hash_version, salt, commits, content_digest)
      VALUES (new_id, at, e->>'kind', e->>'actor', e->>'peer', e->>'summary', hashed, prev, 2,
              e->>'salt', e->>'commits', e->>'digest');
    PERFORM pg_notify('uain_ledger', new_id::text);
    IF e ? 'link' THEN
      CASE e->'link'->>'table'
        WHEN 'tasks' THEN
          UPDATE tasks SET event_id = new_id WHERE id = e->'link'->>'id';
        WHEN 'claim_revisions' THEN
          UPDATE claim_revisions SET event_id = new_id WHERE id = (e->'link'->>'id')::bigint;
        WHEN 'claim_reviews' THEN
          UPDATE claim_reviews SET event_id = new_id WHERE id = (e->'link'->>'id')::bigint;
        WHEN 'karma_events' THEN
          UPDATE karma_events SET event_id = new_id WHERE id = (e->'link'->>'id')::bigint;
        WHEN 'test_attempts' THEN
          UPDATE test_attempts SET event_id = new_id WHERE id = (e->'link'->>'id')::bigint;
        ELSE
          RAISE EXCEPTION 'append_ledger: no link to %', e->'link'->>'table';
      END CASE;
    END IF;
    prev := hashed;
    prev_version := 2;
    ids := ids || new_id;
  END LOOP;
  RETURN ids;
END
$fn$;

-- Which versions of this schema have been applied in full, by the hash of
-- its text (ready() in store.ts). A start whose version is here skips it.
CREATE TABLE IF NOT EXISTS schema_applied (
  hash  text PRIMARY KEY,
  at    text NOT NULL
);
`;

/**
 * Tables in the order rows can be inserted without breaking a foreign key:
 * every table after the tables it points at. Copying and resetting walk it.
 */
export const TABLES = [
  'members',
  'participants',
  'agent_runs',
  'accounts',
  'device_tokens',
  'projects',
  'project_members',
  'amendments',
  'claims',
  'claim_revisions',
  'claim_reviews',
  'tasks',
  'task_workers',
  'task_passes',
  'prior_art_challenges',
  'benevolence_flags',
  'kpi_resolutions',
  'contributions',
  'verifications',
  'events',
  'access_log',
  'item_workers',
  'item_declines',
  'credit_ledger',
  'credit_deferrals',
  'ledger_roots',
  'waitlist',
  'human_proposals',
  'access_rollup',
  'access_callers',
];
