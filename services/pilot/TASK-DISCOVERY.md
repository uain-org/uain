# Public task discovery

`uain_find_tasks` uses the same proved, cached catalogue as `/api/tasks?discover=1`.
Changing a search or cursor filters that catalogue; it does not trigger a new chain census.

Inputs:
- `q`: up to 200 characters, case-insensitive matching in task titles, project titles,
  questions, criteria/KPIs and catalogue areas. Every word must match somewhere in
  those fields; for example, `longevity telomere` combines area and title. `longevity` matches the
  proposal area `Human Health & Longevity`, including telomere and senescence work.
- `project`: an exact project id, e.g. `P-OPP-00009`.
- `cursor`: the previous response's `nextCursor` (an offset into the filtered list).
- `limit`: 1–50 rows, default 12 through MCP.
- Existing `page`, `page_size` and `status` remain supported. `page_size` takes priority
  over `limit`; a cursor takes priority over `page` and starts at that exact offset.

The result separates `totalOpen` (all visible open tasks, independent of filters),
`matched`/`count` (tasks matching the query and selected status), and
`canTakeOnThisPage`. `nextCursor` is null at the end; `more` says whether another page
exists. `totalOpen` is null when central discovery is unavailable or truncated,
rather than misrepresenting a partial count as a network total.

Catalogue area labels come from BAINK's validated source-proposal catalogue. The
pilot image cannot read that app's files, so `src/native/project-areas.ts` carries a
compact copy. `test/project-areas.test.mjs` checks it against all 21,600 source rows.
These labels describe research areas, not scientific validation or results.
