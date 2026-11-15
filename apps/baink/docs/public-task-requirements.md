# Public paid-task requirements

A paid survey refers to exact required identifiers in its verification policy. A criteria hash alone does not tell solvers what to submit. Task detail now returns `requirements` and shows the full operator-published survey policy before joining or submitting. Missing or changed publication is explicit; identifiers are never reconstructed from live searches.

## Trust boundary

The existing native reader still authenticates project, task, reward, criteria (`acceptance_digest`) and `evidence_digest`. The policy is **operator-published**, not a new native proof. Its sorted-key JSON digest must match the exact reviewer policy pin, supplied by the release operator. Each publication also pins task ID, project ID, acceptance digest and task evidence digest. The manifest also pins chain ID and genesis, preventing accidental reuse after a network reset. Changing any native task pin makes this publication unavailable.

The parser accepts only the survey policy schema, driver hash, fixed source-host names, Main KPI, thresholds and canonical identifier list. Additional private fields, paths, prompts and secrets are rejected rather than passed through. This grants no role, signature, budget, acceptance or award.

## Publication / deployment handoff

This source PR does not publish private custody files or change a live task. An authorized operator must:

1. Select the **exact public survey verification policy** already installed for the task. Verify its digest against the central reviewer's current fleet-attestation rule. Do not export the whole reviewer profile or custody environment.
2. Read the current native task with the existing pinned reader. Save just its public task record as JSON.
3. Build a new publication file:

   ```sh
   node apps/baink/ops/export-task-requirements.mjs NEW_OUTPUT.json TASK.json REVIEWED_POLICY.json EXPECTED_REVIEWER_POLICY_DIGEST CHAIN_ID GENESIS_SHA256
   ```

   Existing output is never overwritten. The helper makes no network call, signs nothing and refuses extra policy fields. For multiple tasks, merge only independently validated rows into one `baink-public-task-requirements-v1` manifest, with unique task IDs.
4. Transfer that manifest (not custody profiles or keys) to the BAINK host in a protected, root-owned path. Set `BAINK_CENTRAL_TASK_REQUIREMENTS_FILE` to the exact real path, owned by root or the service user and not group/world-writable, with every ancestor directory equally protected (no symlinks or writable parents). Release with the normal BAINK package/activation procedure. The file is read at startup; new task policies need a reviewed replacement and service restart/release.
5. Sign in as an ordinary holder and read the task: check every required ID, the full JSON, thresholds, Main KPI and policy digest against the exact reviewer policy. Check the missing/mismatch state too. Do not start work while the referenced requirements are unavailable.

Historical tasks without published survey requirements remain readable. No requirements are guessed and no existing ledger bytes change. This deployment requires operator publication; source merge alone does not unblock a live solver.

## Validation

Run `node --test apps/baink/test/central-task-requirements.test.mjs apps/baink/test/central-earning-service.test.mjs`. Tests cover schema restrictions, tamper/digest and task-binding changes, canonical parity, caller mutation, missing publication, oversized files and unsafe/symlink sources. Both root and preview builds must pass. Native earning/signing tests remain unchanged; no financial action is part of this feature.
