# Acceptance for the 120 project organizations

Status on 6 November 2026: **no stage reached. No production organization exists yet.**
Nothing here has been deployed, and no production organization, native project, task,
review or reward has been created for this work.

This page explains how acceptance is measured for the frozen 120-project selection in
[`selection.json`](selection.json). The rules come from the design's "Rollout and
completion criteria" and builder-review resolution 5. The code is
`services/project-organizations/src/acceptance.mjs`, with the rollout planner in
`services/project-organizations/ops/rollout.mjs`.

## Two separate reports

The checker writes two reports. Each has one row for every one of the 120 selected IDs,
in the frozen selection order.

| Report | File | What it covers |
| --- | --- | --- |
| Operational readiness | `operational-readiness.json` | The organization exists, its leaders have run, it is admitted and started natively, its plan is approved, it has an allowance, a task is funded, and a bounded worker has attempted that task. |
| Reward acceptance | `reward-acceptance.json` | A native submission, an independent final review, the exact award receipts, and the account display shows the result. |

The checker also writes `acceptance.json`, which combines both reports. Only the private
BAINK projection reads it. A row can pass one report and fail the other. The overall
request is not complete while either report has a row that does not pass.

## Cells

Each column of each row is a cell `{status, evidence, reason}`:

- `pass`: the evidence listed below exists, is finalized, comes from production, and
  belongs to this project.
- `missing`: the source can be read but the evidence is not there, or it is wrong. Cases
  include a mismatch, a fixture, a non-production chain, or another project's record.
- `unknown`: the source cannot be read, the production chain is not pinned, the native
  proof is not finalized, or a journal intent for this column has an unresolved outcome
  (`claimed`, `dispatched` or `unknown`). Unknown is never counted as zero or as pass.
  When no journal is supplied, every non-pass cell is `unknown` (`journal_unavailable`),
  because writes still in flight cannot be ruled out.
- `held`: a selection hold applies, e.g. `main_kpi_below_native_minimum` when a Main KPI
  is shorter than native's 20-byte plan minimum. A hold covers every column that needs an
  approved plan: approvedPlan, reservedTask, workerAttempt and all reward columns. A held
  project is never replaced. OPP-08881 ("1,000 bridges built", 19 bytes) was held this way
  until Rahul's 6 November decision to update it. Its native Main KPI is now the recorded
  amendment "1,000 bridges built in total" (`kpi-amendments.json`: source wording verbatim,
  same threshold and unit), so no project is currently held.

The following evidence can never fill a cell:

- anything marked `fixture: true`;
- a chain ID other than the pinned production chain;
- an unfinalized proof;
- a snapshot for a different project;
- a task, submission, review or award whose `project` or `task` belongs to a different
  project.

## Operational readiness columns

| Column | Passes only when |
| --- | --- |
| organization | The registry binds a Paperclip company, a CEO agent and a manager agent. A non-fixture Paperclip readback for this project shows the same company, a CEO with role `ceo`, and a manager with role `manager` who reports to that CEO. |
| ceoRun / managerRun | The bound agent has an `actual: true`, non-fixture run with outcome `completed`. Records-only, fixture, wrong-agent and failed-only runs do not count. |
| nativeAdmission | Native `project/P-<id>` is active and not safety-halted. `central_project_budget/P-<id>` exists under `central-earning-five-kpi-fund-v2`, and its manager is the bound native manager. |
| approvedPlan | The approved revision's `central_fund_plan` is `accept`. It has exactly five ordered stages, each with criteria of at least 20 characters. Its `main_kpi` equals the frozen Main KPI word for word. The evaluator is not the manager and is the bound evaluator. |
| allowance | The budget allocation is one of the six cumulative ceilings and at least 10,000 AI$ (10,000,000,000 micro units). The lifetime ceiling is 1,000,000,000 AI$, and `paid + reserved <= allocation`. |
| reservedTask | One of this project's own `central_task` records shows a finalized reservation. Either it is open or under review and exactly reserved, or it is accepted and paid in full, or it was rejected (`open_unfunded`) and the reviewer was paid. |
| workerAttempt | An `actual: true`, `bounded: true`, non-fixture worker attempt for this project targets one of this project's reserved native tasks. |

## Reward acceptance columns

| Column | Passes only when |
| --- | --- |
| submission | A `central_submission` exists for one of this project's tasks. |
| independentReview | A final `accept` or `reject` review comes from the configured central reviewer, who is not the author. Its criteria and evidence digests match. `needs_evidence` is not final and does not count. |
| awards | On accept there are exactly two awards: the solver gets `solver_amount` and the reviewer gets `reviewer_amount`. On reject there is a reviewer award only, and a solver award fails the cell. Each award must match the project, task and submission exactly. |
| accountReadback | Native `central_earnings` covers each award. The BAINK account display shows the same lifetime total for each recipient. If the display is stale or missing, the cell is unknown. |

These rules follow the native semantics in `chain/federation/central_earning.go`:
reviewer checks at line 366, `needs_evidence` at 375, and awards at 391–407. The same
semantics are pinned by `services/project-organizations/test/financial-flow.test.mjs`.
That test is a pure-JS semantic fixture, not chain qualification.

## Private BAINK projection

`GET /api/operations/organizations?page=&pageSize=` is a signed, private, read-only
route. Before it reads any source, it checks the member signature and then the operator
allowlist in `BAINK_ORGANIZATIONS_OPERATORS` (comma-separated addresses, at most 50).
Other members get 403 `organizations_status_forbidden`.

The source is the absolute path in `BAINK_ORGANIZATIONS_ACCEPTANCE_PATH`, which points to
`acceptance.json`. If that file is missing, a symlink, oversized, malformed, or claims a
pass that its cells do not support, the route returns 503
`organizations_status_unavailable`. It never returns an empty or zero report.

Pages default to 20 rows, with at most 60 per page over the 120 IDs. The route copies only
listed evidence fields, so tokens, keys, envelopes and provider USD costs never leave the
host. Public discovery (`/api/work/projects`, `/api/management/initial-tasks`) is
unchanged: drafts stay `draft-held`, unfunded and unpayable. This page does not cover any
visual work.

## Staged rollout gates

The stages are 1, 5, 20 and 120 organizations in total. Each stage is the first N IDs of
the frozen selection order. Held projects keep their place as held, and the planner never
picks a substitute.

`planStage()` is a pure function that changes nothing in production. It refuses a stage
for any of the following:

- selection drift;
- a release manifest that is not the reviewed one, or source bytes that differ from it;
- memory or disk below the minimums pinned in the manifest;
- unknown compute capacity, or compute exhausted for the day or in total;
- pins that differ between hosts;
- a backup older than 24 hours, or a backup of unknown age;
- unresolved journal writes;
- a prior stage in which a member did not pass operational readiness and is not held.

A stage counts as reached only when every member passes or is held, and at least one
member passes.

## Current status

| Stage | Organizations | Reached |
| --- | --- | --- |
| 1 | OPP-00002 | NOT REACHED |
| 5 | first 5 | NOT REACHED |
| 20 | first 20 | NOT REACHED |
| 120 | all 120 | NOT REACHED |

Operational readiness: 0 of 120 pass. Reward acceptance: 0 of 120 pass. No project is
held. No reports have been generated from production sources, because no
production organization, registry binding, leadership run, native admission, plan, task
or award exists yet for this work.

So far the work has been checked only by local unit and HTTP tests, which use fixtures.
Those tests prove the accounting logic, not production behaviour. The Go native
regressions (`go test ./federation/ -run Central`) were not run on the machine that wrote
this page, because it has no Go toolchain.
