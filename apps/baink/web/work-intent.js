import { createActionIntent } from './action-intent.js';
const ADDRESS = /^uain1[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const kind = (value) => value === 'proposals' || value === 'projects';
function check(condition) {
  if (!condition)
    throw Error(
      'The reviewed work source does not match this project or holder. Refresh and review it again.',
    );
}
export function reviewWorkSource(response, expected) {
  const source = response?.source;
  check(
    kind(expected?.kind) &&
      typeof expected.projectId === 'string' &&
      expected.projectId.length > 0 &&
      expected.projectId.length <= 160 &&
      source?.kind === expected.kind &&
      source.projectId === expected.projectId &&
      source.sourceAvailable === true &&
      typeof source.title === 'string' &&
      typeof source.description === 'string' &&
      DIGEST.test(response?.sourceDigest),
  );
  return structuredClone({ source, sourceDigest: response.sourceDigest });
}
export function createWorkSelectionIntent(owner) {
  check(typeof owner === 'string' && ADDRESS.test(owner));
  const intent = createActionIntent();
  return {
    prepare(reviewed) {
      const checked = reviewWorkSource(reviewed, {
        kind: reviewed?.source?.kind,
        projectId: reviewed?.source?.projectId,
      });
      return intent.prepare(
        {
          kind: checked.source.kind,
          projectId: checked.source.projectId,
          sourceDigest: checked.sourceDigest,
        },
        owner,
      );
    },
  };
}
export function selectionProject(selection, owner) {
  check(
    typeof owner === 'string' &&
      ADDRESS.test(owner) &&
      selection?.owner === owner &&
      kind(selection.kind) &&
      selection.source?.kind === selection.kind &&
      selection.source?.projectId === selection.projectId &&
      DIGEST.test(selection.sourceDigest) &&
      ['selected', 'withdrawn'].includes(selection.availability),
  );
  const saved = structuredClone(selection),
    source = saved.source;
  return {
    id: saved.projectId,
    title: source.title,
    description: source.description,
    category: source.category,
    status: source.status,
    url: source.sourceUrl,
    taskCount: source.taskCount,
    _catalogue: saved.kind,
    _selection: saved,
    _storedSource: true,
  };
}
/** A review generation owns its async callbacks, even when the same project is reopened. */
export function createWorkReviewGate() {
  let active = null,
    sequence = 0;
  return {
    open(target) {
      check(
        kind(target?.kind) &&
          typeof target.projectId === 'string' &&
          target.projectId.length > 0 &&
          target.projectId.length <= 160,
      );
      active = Object.freeze({
        kind: target.kind,
        projectId: target.projectId,
        sequence: ++sequence,
      });
      return active;
    },
    close() {
      active = null;
      sequence++;
    },
    capture() {
      return active;
    },
    isCurrent(context) {
      return context !== null && active === context;
    },
    apply(context, update) {
      if (context === null || active !== context) return false;
      update();
      return true;
    },
  };
}
export function selectionForProject(project, sourceKind, owner, records = []) {
  const matches = (entry) =>
    entry?.owner === owner &&
    entry.kind === sourceKind &&
    entry.projectId === project?.id &&
    entry.availability === 'selected';
  return matches(project?._selection)
    ? project._selection
    : records.find(matches);
}
/** Complete marker knowledge is bounded by the server's 100-active-selection holder limit. */
export async function loadWorkSelectionIndex(fetchPage, owner) {
  check(
    typeof fetchPage === 'function' &&
      typeof owner === 'string' &&
      ADDRESS.test(owner),
  );
  const first = await fetchPage(1);
  check(
    Number.isSafeInteger(first?.count) &&
      first.count >= 0 &&
      first.count <= 100 &&
      first.pages === Math.max(1, Math.ceil(first.count / 25)),
  );
  const pages = [
      first,
      ...(await Promise.all(
        Array.from({ length: first.pages - 1 }, (_, i) => fetchPage(i + 2)),
      )),
    ],
    records = [],
    ids = new Set(),
    projects = new Set();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i],
      expected = Math.min(25, Math.max(0, first.count - i * 25));
    check(
      page?.count === first.count &&
        page.pages === first.pages &&
        page.page === i + 1 &&
        page.pageSize === 25 &&
        Array.isArray(page.selections) &&
        page.selections.length === expected,
    );
    for (const selection of page.selections) {
      selectionProject(selection, owner);
      const key = selection.kind + ':' + selection.projectId;
      check(
        selection.availability === 'selected' &&
          !ids.has(selection.id) &&
          !projects.has(key),
      );
      ids.add(selection.id);
      projects.add(key);
      records.push(structuredClone(selection));
    }
  }
  return { selections: records, count: first.count };
}
