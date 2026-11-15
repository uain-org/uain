# Bounded manager planning and durable execution accounting

Parent-approved source implementation is qualified in isolation; no configuration change or runtime activation is present. This extends fairness commit170871. Preserve rolling30, max one project/run,360-minute cooldown, default provider, current member capabilities, native reward obligations and all scientific/funding/central-review gates.

## Bound proof

Current flow has exactly one stage-provider call site in runLeadership for each of CEO and manager, and one assessPriorArt provider call for each returned task. Fixed primary-source retrieval and deterministic pricing do not invoke a model. With an enforced maximum N returned tasks, invocations are at most B=2+N. Every exception/unknown invocation counts; there is no retry. For N=1, B=3, so22+3<=30 and five operational executions remain. The current offered-candidate length is not N: managers may ignore/adapt suggestions and return eight tasks. The current10 bound remains correct until the following interfaces, accounting and tests are qualified.

## Protected configuration

Keep `uain-manager-stage-config-v1` and its five existing fields. An optional exact integer `max_tasks_per_project_run` in1..8 narrows the bound. Absence defaults to N8/B10 and preserves old configuration bytes, default prompts and input digests. The existing daily-config minimum remains10. Intended future protected config would add only N1, preserving max_executions_per_day30, max_projects_per_run1, cooldown_minutes360 and the exact project list. No environment/model/browser input chooses N. Both JS validateConfig and Python load_config validate exact keys/types/schema and derive B=2+N. Python validates explicit mode summary fields before accepting batches.

## Source interfaces

- `planningExecutionBound(config)` returns the integer B=2+N after strict validation. Use it before any provider dispatch; admit only `rollingUsed + maxProviderCalls <=30` (using the configured unchanged limit).
- `stageProject(..., planningBound)` passes the admitted limit only to the manager leadership call. CEO behavior remains unchanged. Narrowed-mode manager input includes a fixed task_limit, bound into its prompt/input digest. Absent/default8 prompts and input digests remain unchanged.
- `runLeadership(..., taskLimit)` accepts the option only for the manager role and only from the validated stage. Check the raw parsed `tasks` array length before per-task sanitization, candidate attribution, price calculations, source retrieval or assessment. If length>N, retain a refused manager report (`task_execution_bound_exceeded`) and reject the whole batch; never truncate an oversized batch into validity. Both leadership attempts still count.
- Existing candidate suggestions remain data. One-task mode may choose one genuine adapted proposal; it does not force the sole offered candidate to be novel. A retained candidate_id still requires exact offered content.
- Retain all existing task-state, survey/Main-KPI, approved-five-stage-plan, manager/evaluator, allowance/global-supply, evidence, novelty and native signing checks. Execution headroom cannot authorize a reservation or payment.

## Durable conservative accounting

Prove accounting survives death/lost output before admitting the lower bound. The present completed-run counter alone is insufficient proof for a process dying before its final run file; do not infer zero executions from absent receipts.

Use an append-only version1 execution claim, written/fsynced, including ancestor directory entries, before the first provider dispatch under the existing serialized driver: `{schema,runId,project,startedAt,configDigest,maxTasks,maxProviderCalls}`. Preserve old completed run files and hashes. Before every provider call an exact execution ID/role/prompt-digest attempt is durably retained. A terminal v2 run references the exact claim digest and records actual attempt count in0..B. History joins claim/terminal by exact project/run/digest, counting a qualified terminal once at its actual count; an unmatched/unknown claim consumes its full B for the existing rolling window and supplies the project's attempt/cooldown timestamp. It is never deleted/replayed or counted as unused. Corrupt/foreign/ambiguous claim/terminal bindings hold rather than free capacity. Count provider dispatch before awaiting output; CEO/manager unknowns and every assessor unknown are charged. Native/publication uncertainty continues to use the existing custody journal hold/reconciliation rules.

This is attempt-window accounting, like current history(startedAt), not USD or final remote-completion billing. No claim may be resumed with a new execution identifier to evade a retained unknown. Any later operator reconciliation attaches only exact retained execution evidence; it never re-executes a lost request. Legacy runs retain their current conservative fallback of10 when an execution count is missing. No legacy backfill or hash rewrite is needed.

## Required tests and qualification

1. JS/Python absent/default8 compatibility; optional N1..8, malformed/extra/noninteger limits refuse; both derive2+N. Config30/360/max1 and project order remain unchanged apart from the optional limit.
2.22used admits N1/B3,27used admits one more3,28used refuses without a provider call; old v1 at22 remains held by B10. No mode can make the sum exceed30.
3. Known terminal charges actual attempts. Any CEO/manager/assessor transport unknown charges FULL B and globally holds planning even after its rolling charge ages out. A valid one-task flow invokes at most three provider calls. No second attempt or hidden retry.
4. Raw two/eight/oversized arrays in N1 mode refuse before retrieval, assessor, pricing or native batch. Zero task output and malformed JSON preserve strict existing verdict semantics.
5. Crash before dispatch, after each dispatch and before terminal durability retains a full-bound claim; restart history never frees or double-counts it. Wrong/missing/replayed claim bindings hold. Original run/native journals remain unchanged.
6. Preserve fairness, cooldown, open-task, plan/fund, novelty/reviewer gates and bounded prompt/output/resource checks. Full current JS and relevant Python suites plus independent review are required.

Only after source publication and a complete artifact preserving all794 current organization paths/V2 modules may a separately reviewed exact-prior protected config delta select optional N1. Follow the normal idle/common-lock/read-only acceptance gates; let the normal timer run. Do not force a provider/native command or advertise paid availability without an actual novelty-qualified native opening receipt.

## Qualification and legacy admission

Focused Node56/56; isolated root Linux organization/central501/501; Python142 total141pass/1 existing root-mode refusal skip. Adjacent Fund qualification is recorded separately. A first Fund harness lacked the private writable fixture mount; that harness error remains retained and no production/test safety guard was weakened.

Read-only legacy correlation found10 terminal stage records,16 matching leadership reports,0 orphan leadership execution IDs,0 explicit provider-unknown outcomes and0 batches. All135 automated manager-stage systemd invocations in the observed rolling24-hour window retained complete driver reports. Six model-bearing runs account for exactly22 retained CEO/manager/assessor execution IDs, each matched to its terminal record; no unresolved invocation was found. The actual fc00 fence uses ephemeral CLI state in a deleted temporary namespace and has no durable pre-dispatch journal. This is retained operator evidence, not proof against an invocation dying before its first retained write or an unlogged manual call. This qualifies practical automated manager accounting within the OS/journal trust boundary; it makes no manual CLI or subscription-quota claim. A later activation/config request must recheck the current window and hold if usage cannot be bounded; never assume unused capacity or backfill claims.

The new claim module adds one runtime path; the future compatible release preserves all794 current726 paths and the V2 modules, adding the claim module without unrelated unqualified worker changes. Production Python replacement, JavaScript pointer and protected config changes remain separately reviewed operations.

Production concurrency remains serialized by the existing owning Python `.driver.lock`, tested before proposal admission. Exclusive individual claim publication does not replace that global driver lock across different run IDs.

## Rollback boundary

The old726 manager does not read the prospective execution-claim/v2-terminal accounting. Exact-prior rollback is allowed only while related timers remain stopped and a fresh inventory proves no new claim/terminal was created. After any new claim exists, preserve all claims, records and the original lock inode; do not downgrade to a reader that could ignore them. Hold the related timer and use an independently reviewed compatible forward fix or exact retained-outcome reconciliation. Never delete a claim, reset history, replace an uncertain execution ID or backfill a legacy absence.
