# 10 new tasks (20 November 2026)

Operator request, 20 November 2026: write and open 10 new tasks.

Nothing here is opened, signed or funded. This is a batch ready for review and for the manager
stage on the custody host.

## Files

- `drafts.json`: 10 **new** tasks written on 20 November 2026, one per project, on 10 projects that
  had no tasks beyond their prior-art surveys. Each uses a fixed ClinicalTrials.gov query plus PubMed
  checks that a verifier reruns exactly. There are three proven task shapes: registered-versus-published
  outcome audits, results-reporting audits and registry censuses.
- `candidates.draft.json`: the same tasks converted by
  `services/project-organizations/ops/manager-candidates.mjs build`. It passes `check` against the
  frozen selection. `reviewed.by` says `PENDING operator review` on purpose: rebuild it with the
  reviewer's name.

## The 10 tasks

Audits pay 200000000 / 50000000 micro-units (solver / reviewer); censuses pay 150000000 / 40000000.

| # | Project | Task | Est. | Trials today |
|---|---|---|---|---|
| 1 | OPP-00246 | Microneedle and microarray-patch vaccine trials: registered versus published primary outcomes | 40 min | 21 |
| 2 | OPP-00243 | Completed hexavalent infant vaccine trials: results-reporting audit | 40 min | 13 |
| 3 | OPP-00248 | Personalised neoantigen cancer vaccine trials: census of registered primary endpoint types | 45 min | 28 |
| 4 | OPP-00722 | Completed retinal prosthesis trials (Argus II, PRIMA and others): registered versus published primary outcomes | 45 min | 16 |
| 5 | OPP-00966 | Interactive voice response maternal health trials: census of delivery languages | 30 min | 9 |
| 6 | OPP-00965 | Completed HPV self-sampling trials: results-reporting audit | 45 min | 28 |
| 7 | OPP-00245 | Completed pharmacy-based vaccination trials: registered versus published primary outcomes | 30 min | 9 |
| 8 | OPP-00969 | Completed midwife-led care trials: results-reporting audit | 50 min | 30 |
| 9 | OPP-00963 | Completed rural telehealth hypertension trials: registered versus published primary outcomes | 30 min | 7 |
| 10 | OPP-00485 | Completed communication brain-computer interface trials: census of registered primary endpoints | 40 min | 20 |

Checks run on 20 November 2026:
- None of the 10 exists on uain.global (open, answered, under review or closed).
- All 10 projects exist natively, are `active`, and are in the frozen selection (not held).
- Each query returns 7 to 30 studies, so each task fits in under an hour.
- One PubMed prior-art search per topic (recorded in each draft) found no audit of the same question.
  The trusted search and independent assessment still run in the manager stage.

## The survey gate

`manager-stage.mjs` only proposes follow-on tasks for a project whose prior-art survey is accepted
and that has no other open task. On 20 November 2026 each of these 10 projects still has 6 to 8 open
survey parts, so the stage will report them as gated until those surveys finish. There is no config
switch to skip this. Opening them early needs a reviewed code change by the custody owner, recorded as
a deliberate exception.

## Steps on the custody host (root)

```bash
cd /opt/uain-organizations/current      # a reviewed release that contains this folder
NODE=/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin/node
$NODE services/project-organizations/ops/manager-candidates.mjs build \
  docs/baink/project-organizations-2026-11-06/small-tasks-2026-11-20/drafts.json \
  --reviewed-by "<reviewer name>" --reviewed-at <YYYY-MM-DD> \
  --source small-tasks-2026-11-20/drafts.json > /root/candidates.json
$NODE services/project-organizations/ops/manager-candidates.mjs check /root/candidates.json
install -o root -g root -m 0600 /root/candidates.json /etc/uain-custody/manager-stage/candidates.json
# add the 10 projects to /etc/uain-custody/manager-stage/config.json "projects" (back it up first)
/opt/uain-custody/venv/bin/python -I /opt/uain-custody/manager_stage.py check
systemctl start uain-manager-stage.service
```
