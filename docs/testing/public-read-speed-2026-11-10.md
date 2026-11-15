# Public project pages while the chain is busy (10 November 2026)

Package: make `/api/projects`, project pages and `/api/stats` on uain.global
fast and reliable while native events land (the task-stock fill signs about one
starter run every 20 seconds). Code: `services/pilot/src/api/native-public-read-routes.ts`,
`services/pilot/src/native/public-browse.ts`, `services/pilot/src/native/public-read.ts`.

## 1. Before: measured on production

Read-only. 20 rounds from this Mac over HTTPS, one request every 2 seconds in
the order `/api/projects`, `/api/projects/alzheimer-s-disease-open-questions-answered-from`,
`/api/stats`; the fill was running and other sessions were rolling out pilot
pods at the same time (several rollouts between 23:05 and 23:40 UTC).
Script: `measure.mjs` (kept in the session scratchpad; it only sends GETs).

Window: 2026-11-09 23:08:18 to 2026-11-09 23:20:01 UTC, events 1259 to 1275.

| Path | Requests | p50 | p95 | Max | Errors | Status codes |
| ---- | -------: | --: | --: | --: | -----: | ------------ |
| `/api/projects` | 20 | 21.7 s | 30.3 s | 30.3 s | 11 (55%) | 200×9, 503×2, 504×9 |
| `/api/projects/:id` | 20 | 1.5 s | 19.4 s | 29.6 s | 2 (10%) | 200×18, 503×2 |
| `/api/stats` | 20 | 0.6 s | 10.8 s | 14.4 s | 2 (10%) | 200×18, 503×2 |

The 503s were `native_public_read_unavailable` (two rounds where all three
paths refused together, during a pilot rollout). The pod logs do not count
proof batches or restarts per request (they log only warm-up failures), so the
counts below come from profiling one read inside a pod instead.

One cold read profiled inside a production pod (`pilot-5f5d94b87d-9wmkv`,
23:22 UTC), through the deployed code, counting PostgreSQL queries and proof
processes:

| Read | Time | Result | SQL queries | Proof processes | Proof time (sum) |
| ---- | ---: | ------ | ----------: | --------------: | ---------------: |
| `/api/projects` | 40.5 s | refused: `native public proof checkpoint changed` | 14,150 (21.2 s) | 147 | 29.5 s |
| `/api/projects/alzheimer-…` (next generation) | 20.5 s | 200 | 387 | 84 | 36.8 s |
| `/api/stats` (same generation) | 0.4 s | 200 | 101 | 3 | 0.2 s |

What the numbers say:

- **Most of the time is not the chain.** One `/api/projects` read sends
  14,150 queries: every project row re-walks every contribution (two queries
  each) and every task, and `ids()` re-reads the event projection on every
  call. 42 projects × 83 contributions × 2 is already about 7,000.
- **Every event throws the work away.** The 147 proof batches (about 4,700
  keys) must all match the page's head checkpoint. A proof took 200–440 ms in
  a loaded pod (74 ms is the figure next to the ledger with no load), so the
  read lasts 20–40 s and an event almost always lands inside it. The proof
  cache is also per event count, so the next page after an event starts cold
  (84 proofs for one project page).
- The gateway cuts at 30 s, so a page that would have finished at 35 s is a
  504, and the retries (3 per request) make it worse.

## 2. Design

The rule stays: every row a member sees comes from a native proof on the
pinned chain, and nothing falls back to unproved or stale state silently.
What changes is that a browse page no longer has to be proved inside one
event window, and it says how old it is.

**Which reads change.**

| Browse views: answered from the last proved result | Strict: bound to the newest block, unchanged |
| -------------------------------------------------- | -------------------------------------------- |
| `/api/projects`, `/api/tasks` (including `?discover=1`), `/api/directory`, `/api/contributions`, `/api/stats`, `/api/directory/map`, `/api/projects/<id>` and its `/tasks`, `/claims`, `/members` | `/api/tasks/<id>` (with or without `discover=1`), `/api/contributions/<id>`, `/api/members/<id>`, `/api/directory/<id>`, `/api/native/events`, and every `/api/native/public/...` path (the strict twin of each browse view) |

Nothing a write or a payment decision depends on is a browse view: balances,
members, single tasks and contributions stay strict, and a submission
re-checks its task on chain anyway. Anyone who needs the head-bound answer for
a list asks the `/api/native/public/...` twin.

**How a browse page is proved.**

1. A pod keeps one *proved view* per pin set, chain id, genesis epoch and
   archive-visibility version (the same key parts the central cache uses).
   The view opens with a fresh strict checkpoint (proof plus projection
   catch-up), then proves records on demand in batches of at most 32 keys.
   Each batch is a complete native proof at its own height: it must name the
   same chain and must not be behind the view's opening event count. An event
   landing during the read no longer discards anything already proved.
2. Every page of that view shares its proved records and the rows derived
   from them, so the projects list, the stats and 168 project pages cost one
   census of proofs, not one each.
3. A view is replaced at most once a minute, and only when the chain moved.
   The 5 s warm pass checkpoints every time: when the event and journal
   counts and the publications are unchanged (and every batch was proved at
   the opening count), the view and all its pages are re-dated without new
   proofs, so on a quiet chain pages are seconds old.
4. Each answer carries a `proved` block, in plain words:
   `as_of` (the view's opening checkpoint time), `age_seconds`,
   `heights.from`/`heights.to`, `consistent_snapshot` (true only when every
   batch was proved at the opening event count), and a one-line `note`.
5. Freshness bounds: once its view is a minute old, a page is rebuilt in the
   background while the old one is served; a page older than 5 minutes
   (counted from `as_of`) is never served. Discovery deadlines are judged
   against the view's proved block time plus the time since.
   Each view replacement logs one line with what the old view proved (keys,
   batches, heights).
6. Cold pod or missing page: the request waits up to 20 s for the build,
   then answers `503` with `Retry-After: 5` and a plain message, well inside
   the 30 s gateway; the build continues so the retry finds it.
7. Memory is bounded: at most 2 views (20,000 proved keys each) and 1,024
   pages or 64 MB of page results per pod, oldest evicted first. The website
   snapshot store goes from 256 to 1,024 entries (32 MB unchanged): six core
   pages plus four per project pass 256 at 63 projects.
8. Readiness is unchanged in kind: a pod is ready once the six core pages
   have been proved once and its last checkpoint is under 120 s old. The
   project pages and every on-demand page stay best effort.

**Also changed.** Inside one read the reader now remembers each derived row
(project, task, contribution, claim, member, participant) and each catalogue
id list, so one `/api/projects` read sends a few hundred queries instead of
14,000. The strict reads get this too; their proof checks are unchanged.

**Tests whose rule changes.** Two assertions encoded "a list must be proved at
this instant" rather than "a list must be proved": "one fresh checkpoint per
request" (a browse hit now needs no proof at all) and "changed unprojected
head must never serve prior cached state" for `/api/projects` (the browse
view now serves its proved page with its age; the strict twin
`/api/native/public/projects` still refuses). Both now assert the strict
twin, plus the browse labelling.

## 3. After

**The new code on production data before deploying** (compiled branch copied
into `/tmp` of pod `pilot-5c5bd6fd58-hkm6g`, run read-only against the live
chain and database, 23:23–23:32 UTC; that pod was still warming up, so proofs
were slow, 300–600 ms each):

| Read (in order) | Time | Result | SQL | Proofs |
| --------------- | ---: | ------ | --: | -----: |
| `/api/stats` (opens a view) | 9.6–18.1 s | 200 | 100 | 57 |
| `/api/projects` (same view) | 10.9–11.4 s | 200, 44 projects, `consistent_snapshot: true` | 55 | 119 |
| `/api/projects/alzheimer-…` | 0.05 s | 200 | 3 | 0 |
| `/api/projects` again | 0.002 s | 200 | 2 | 0 |
| `/api/tasks?discover=1` | 2.7 s | 200, 125 rows | 2 | 27 (central rows) |
| strict `/api/projects` | 8.1 s | refused: `checkpoint changed` | 19 | 48 |

- One view costs about 176 proofs (about 5,600 keys) and about 13 CPU-seconds
  in the pod (cgroup counter: 0.57 cores before, 1.01 cores during a 29 s
  census). At one view a minute that is about 0.2 cores per pod.
- 32 keys is the proof reader's limit: 48, 64 and 96 keys were each refused
  (`native proof verification refused`), 16 and 32 succeeded (0.3–1.0 s).
  The batch size stays 32.

**Deployed:** PR #410 merged as `175647ad`; deploy run 42727001236 succeeded
at 00:23 UTC; the pilot rollout completed with 4 pods ready about 2 minutes
after they started, while the fill was running (on 9 November rollouts stalled
for up to an hour). Same script, same client, same three paths.

Sample A, one request every 2 s (the before setting; the connection stays
open between requests):

Window: 2026-11-10 00:24:08 to 2026-11-10 00:26:42 UTC, events 1363 to 1367.

| Path | Requests | p50 | p95 | Max | Errors | Status codes |
| ---- | -------: | --: | --: | --: | -----: | ------------ |
| `/api/projects` | 20 | 0.6 s | 0.7 s | 1.2 s | 0 (0%) | 200×20 |
| `/api/projects/:id` | 20 | 0.9 s | 0.9 s | 0.9 s | 0 (0%) | 200×20 |
| `/api/stats` | 20 | 0.3 s | 0.3 s | 0.4 s | 0 (0%) | 200×20 |

Page age (`proved.age_seconds`): 1 to 76 s.

Sample B, one request every 10 s over 11 minutes (each request opens a new
TLS connection from this Mac, about 0.6 s of the time shown):

Window: 2026-11-10 00:26:53 to 2026-11-10 00:37:53 UTC, events 1367 to 1383.

| Path | Requests | p50 | p95 | Max | Errors | Status codes |
| ---- | -------: | --: | --: | --: | -----: | ------------ |
| `/api/projects` | 20 | 1.2 s | 1.2 s | 1.8 s | 0 (0%) | 200×20 |
| `/api/projects/:id` | 20 | 1.4 s | 1.6 s | 1.7 s | 0 (0%) | 200×20 |
| `/api/stats` | 20 | 0.9 s | 0.9 s | 1.1 s | 0 (0%) | 200×20 |

Page age: median 46 s, 95th percentile 77 s, maximum 80 s; 24 of 60 answers
were one consistent snapshot, the rest say they were put together from proofs
at a few nearby heights.

| `/api/projects` | Before | After (A) | After (B) |
| --------------- | -----: | --------: | --------: |
| p50 | 21.7 s | 0.6 s | 1.2 s |
| p95 | 30.3 s | 0.7 s | 1.2 s |
| Errors | 11 of 20 (9 × 504) | 0 of 20 | 0 of 20 |

Target met: p95 under 3 s and no 504s during the fill. From this Mac the
floor is about 0.3 s (one round trip to Tampa) plus 0.6 s for a new TLS
connection; the pilot itself answers a held page in a few milliseconds
(0.002 s in the in-pod run).

Other live observations, 00:24–00:40 UTC:

- **Strict reads still work beside the census.** `/api/tasks/T-37?discover=1`
  (the read a member's agent makes before submitting): 8 of 8 answered 200 in
  1.4–4.3 s.
- **Pod logs** now say what each view cost: the first view of a new pod proved
  3,168 keys in 152 batches, later ones 2,499 keys in 121–137 batches (the
  original rows stay cached). Each pod opened about one view a minute.
- **CPU:** the autoscaler read 52% then 24% of its 60% target with 4 pods
  (before: 51–61%); a pod uses about 0.7 cores while it proves a view and
  0.02–0.05 between views.
- **One unexplained outlier.** At 00:48 UTC one website snapshot request
  (`/api/projects?site_snapshot=1&page_size=1`, a path that does no chain
  work) took 30.0 s, then answered 200. It did not recur: 12 immediate
  repeats took 0.9 s each, and a 3-minute probe right after (180 requests,
  one a second, five browse and snapshot paths, across two view replacements)
  had 0 errors, p50 0.29 s, p95 0.59 s, maximum 0.89 s. The cause is not
  known; a request queued behind a pod's busy database pool while a view was
  opening is a guess, not a finding.
- **A race, fixed in a follow-up:** when a request and the warm pass both
  found a view due, each could open a new one ("view 5 … view 4 proved 0
  keys"), proving the census twice. Now whichever checkpoint returns second
  reuses the view the first one opened.

## 4. Starter pace

Question: can the task-stock starter now run more often than every 20 s?

- **Public pages: yes, they no longer limit it.** A browse view is replaced
  at most once a minute however many events land, so neither the page time
  nor the proof load of these pages grows with the event rate. During both
  samples events landed about every 40 s (the 20 s starter signs on about
  half its runs) and no page failed; at 10 s the 9 November failure (whole
  page reads discarded by each event) cannot recur, because nothing is
  discarded any more.
- **Rollouts: no longer a limit.** New pods turned ready in about 2 minutes
  with events landing; readiness needs only the six core pages, proved once.
- **Not tested at 10 s, so still the limits:** strict reads (single tasks,
  members, contributions) still retry when an event lands mid-read, and every
  extra starter run is extra proof work on the native node, which was the
  suspected cause of `native proof verification refused` under load on 9
  November (`task-stock-read-load-20261109`).

Recommendation: try 10 s (not lower) with a watch for 30 minutes on
`/api/tasks/<id>?discover=1` (expect 200s), `uain_find_tasks`, and the pilot
logs (`native proof verification refused`, `warm-up: failed`); go back to 20 s
if either appears. The pace belongs to the task-stock session; this session
did not change it.

## 5. Proof reads per view

Measured 10 November, 08:20–08:48 UTC.

Question (register: "pilot warm-up CPU" and "`/api/projects` takes 20–30 s
while native events land"): what does one view still cost a replica, and what
of it is waste?

**State found.** The eviction the register describes is gone since section 3:
the website snapshot store holds up to 1,024 entries, and all pages of a view
share one reader. Production at 08:20 UTC, 69 projects: the warm pass holds
282 pages (6 + 4 × 69), about 4.2 MB of JSON as served (measured over HTTPS,
every page), against bounds of 1,024 entries and 32 MB (snapshots) or 64 MB
(pages). Nothing is evicted. The entry bound is reached at 254 projects.
On a quiet chain a replica uses 24–27 millicores: each 5 s pass is one
checkpoint and no page proof. When the chain moves, each replica opens one
view a minute: `proved 2718 keys in 145 batches` in the pod logs (the central
task reads are not in that count).

**Profile.** `services/pilot/scripts/profile-view.mjs`, run inside one
production pod (`pilot-55dfcf8896-5stvf`), builds the same 282 pages through
the given code in a fresh process and counts proof processes and SQL. Read
only; each run costs what one view costs. Deployed code (`cf20a195`) and the
compiled branch, two minutes apart:

| One view, 69 projects, 282 pages | Deployed | Branch |
| -------------------------------- | -------: | -----: |
| Proof reads | 266 | 168 |
| Keys proved | 4,786 | 4,089 |
| Proof reads of one key | 64 | 8 |
| `/api/projects`, cold | 13.6 s, 163 proofs | 11.2 s, 110 proofs |
| `/api/tasks` after it | 3.3 s, 45 proofs | 0.05 s, none |
| 276 project pages | 2.6 s (2.3 s CPU) | 1.0 s (0.7 s CPU) |
| Whole pass | 33.0 s | 22.6 s |
| SQL queries | 809 | 810 |
| Refused proofs | 0 | 0 |

A proof read took about 190 ms in the pod in both runs.

**Deployed** (#476, `843b915e`, live 09:30 UTC). The same profile on the
deployed code in pod `pilot-78f76b84b4-kdgff` at 09:32 UTC: 168 proof reads,
8 of one key, whole pass 20.3 s, the 276 project pages 0.9 s, none refused.

**What the waste was.**

- **55 proofs of one key each.** `project()` proved every member's
  participation record alone, one process each, in turn. The census now plans
  them with its other keys (two batches).
  Each record is still checked against its join event.
- **Central tasks proved twice.** The project list proved every central task
  again under its own cache key, only to count them (45 reads). Both lists now
  share one proved result; the counts are the same, because the project list
  only has visible projects.
- **The catalogue walked for every page.** Each of the 276 project pages
  re-planned the whole census (about 3,000 keys) to find nothing missing. A
  reader now plans a kind once.

**Left as it is.** Central records are still proved 16 keys at a time (43
reads a view). The reader accepts 32, but a refused central read empties the
task list, so that change needs its own fallback and test. The 10 one-key
catalogue reads happen once per process, not per view.

**What a member sees.** Nothing changes in any answer. The strict twins use
the same reader, so `/api/native/public/projects` needs 53 fewer proof reads
inside its one event window.
