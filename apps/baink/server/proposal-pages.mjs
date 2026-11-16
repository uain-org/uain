import { createHash } from 'node:crypto';

const WORKBOOK_SHA =
  '4419baef812bde5e33718e5e6acc76e1d7dde6fc95574ba79cd0c66955feb5d2';
const REPOSITORY = 'https://github.com/nuah-org/uain-project-incubator';
const ID = /^(OPP|PRB)-\d{5}$/;
const PATH =
  /^\/proposals\/((?:OPP|PRB)-\d{5})(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/;
const text = (value, max, min = 0) =>
  typeof value === 'string' && value.length >= min && value.length <= max;
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (pattern, value) =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;

function originValue(value) {
  try {
    const url = new URL(value);
    if (
      typeof value === 'string' &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      value === url.origin
    )
      return value;
  } catch {
    /* Configuration errors never become request-derived origins. */
  }
  throw new TypeError(
    'A complete HTTP(S) origin without credentials, path or query is required.',
  );
}

function titleSlug(title) {
  return (
    title
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/g, '') || 'proposal'
  );
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

// Only the already validated catalogue DTO is projected. Extra provider fields
// (including native or financial authority) are deliberately never copied.
function snapshot(detail, id) {
  const p = detail?.project,
    s = detail?.source,
    k = p?.kpi,
    v = p?.provenance;
  if (
    !record(p) ||
    !record(s) ||
    !record(k) ||
    !record(v) ||
    p.id !== id ||
    !exact(ID, id) ||
    !text(p.title, 1000, 1) ||
    !text(p.description, 2000) ||
    !text(p.category, 200, 1) ||
    !exact(/^(?:[1-9]|[1-3][0-9]|4[0-5])$/, p.domainId) ||
    p.kind !== (id.startsWith('OPP-') ? 'Opportunity' : 'Problem to solve') ||
    p.status !== 'inactive' ||
    p.operationalStatus !== 'not_started' ||
    p.progress !== null ||
    !text(p.notice, 2000, 1) ||
    !text(k.statement, 2000) ||
    !text(k.unit, 2000) ||
    !text(k.qualification, 2000, 1) ||
    !(
      k.threshold === null ||
      (typeof k.threshold === 'number' && Number.isFinite(k.threshold))
    ) ||
    k.comparator !== null ||
    v.source_sha256 !== WORKBOOK_SHA ||
    v.sheet !== 'All items' ||
    !Number.isInteger(v.row) ||
    v.row < 2 ||
    v.row > 21601 ||
    s.status !== 'available' ||
    s.kind !== 'source-proposals' ||
    s.repository !== REPOSITORY ||
    !exact(/^[a-f0-9]{40}$/, s.revision) ||
    s.workbookSha256 !== WORKBOOK_SHA ||
    s.validatedCount !== 21600 ||
    s.domainCount !== 45 ||
    !['sha256-verified', 'schema-and-provenance-verified'].includes(
      s.integrity,
    ) ||
    !text(s.notice, 2000, 1)
  )
    throw new TypeError('Invalid catalogue projection');
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category,
    domainId: p.domainId,
    kind: p.kind,
    kpi: {
      statement: k.statement,
      threshold: k.threshold,
      unit: k.unit,
      comparator: k.comparator,
      qualification: k.qualification,
    },
    provenance: { source_sha256: v.source_sha256, sheet: v.sheet, row: v.row },
    source: {
      status: s.status,
      kind: s.kind,
      repository: s.repository,
      revision: s.revision,
      workbookSha256: s.workbookSha256,
      validatedCount: s.validatedCount,
      domainCount: s.domainCount,
      integrity: s.integrity,
      notice: s.notice,
    },
    status: 'inactive',
    operationalStatus: 'not_started',
    progress: null,
    nativeAdmission: false,
    fundingAvailable: false,
    crewAvailable: false,
    executionAvailable: false,
    notice: p.notice,
  };
}

export function createProposalPages({ catalogue, origin }) {
  const publicOrigin = originValue(origin);

  function modelFor(id) {
    if (catalogue?.available !== true || typeof catalogue.detail !== 'function')
      return { status: 503 };
    try {
      const detail = catalogue.detail(id);
      if (detail === null) return { status: 404 };
      const fields = snapshot(detail, id);
      const canonicalUrl = `${publicOrigin}/proposals/${id}-${titleSlug(fields.title)}`;
      const model = {
        ...fields,
        canonicalUrl,
        jsonUrl: canonicalUrl + '?format=json',
        workspaceUrl: publicOrigin + '/?view=mine',
      };
      // This hash binds the complete emitted projection, including source and
      // KPI qualifications. It is neither a work-selection digest nor a native
      // proof, and does not include itself in the hashed payload.
      const payload = {
        schema: 'baink/proposal-document/v1',
        projection: 'inactive-source-proposal',
        ...model,
      };
      const revision = createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');
      return {
        status: 200,
        model: freeze({ ...model, document: { ...payload, revision } }),
      };
    } catch {
      return { status: 503 };
    }
  }

  return Object.freeze({
    resolve(pathname) {
      if (typeof pathname !== 'string' || pathname.length > 101)
        return { status: 404 };
      const match = PATH.exec(pathname);
      if (!match || match[0] !== pathname || (match[2]?.length ?? 0) > 80)
        return { status: 404 };
      const result = modelFor(match[1]);
      if (result.status !== 200) return result;
      return result.model.canonicalUrl === publicOrigin + pathname
        ? result
        : { status: 308, location: result.model.canonicalUrl };
    },
    decorate(result) {
      if (!record(result)) return result;
      const decorateProject = (project) => {
        if (!record(project) || !exact(ID, project.id)) return project;
        const resolved = modelFor(project.id);
        if (resolved.status !== 200) return project;
        return {
          ...structuredClone(project),
          pageUrl: resolved.model.canonicalUrl,
          documentUrl: resolved.model.jsonUrl,
        };
      };
      return {
        ...result,
        ...(Array.isArray(result.projects)
          ? { projects: result.projects.map(decorateProject) }
          : {}),
        ...(record(result.project)
          ? { project: decorateProject(result.project) }
          : {}),
      };
    },
  });
}
