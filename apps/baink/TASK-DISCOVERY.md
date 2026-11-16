# Public task discovery

`baink_tasks` and `GET /api/public/tasks` accept `q` (100 characters), `project` (exact project ID), `cursor` (numeric offset) and `limit` (1–50, default 12). Every query word must appear in the title, criteria/KPI, project goal or catalogue research area. No query match means no open task matched; it does not establish absence of a project.

`totalOpen` is the complete global open count before filters; `matched` is the filtered count; `canTakeOnThisPage`/`returned` count this page. `openNow` is a deprecated alias for the page count, retained for one compatibility release. Pass `nextCursor` as `cursor`, retaining q/project. Discovery is advisory: a member's own submitted tasks and subsequent state changes can prevent claiming.

The server follows at most 4096 indexed tasks in 48-row proved pages (two pages in flight), deduplicates IDs and caches the full open index for 60 seconds. All searches share one in-flight refresh with a 90-second deadline. During refresh a previous snapshot can serve for five minutes, with cachedAt; after that, or if no complete snapshot exists, failure is unavailable, never a partial total. A cold request waits up to 7.5 seconds; if the index is still warming it returns unavailable while the shared load continues. Different pages are proved independently; consistentSnapshot is false. No arbitrary query can trigger its own chain scan.

Kit `tasks --q "longevity" --project P-OPP-00009 --cursor 0 --limit 12` uses the same public list, then omits the member's own finalized submissions. `--level` filters locally. Follow nextCursor even if local filtering empties a page. `--all` remains the existing signed listing and cannot combine with search.

Cold HTTP responses use status unavailable, warming:true, retryAfterSeconds:10 and error code tasks_warming; they omit totalOpen. MCP returns the same warming fields. snapshotAgeSeconds and refreshing identify stale-while-refresh responses.
