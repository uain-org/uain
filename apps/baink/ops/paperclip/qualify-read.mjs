import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPaperclipReadBridge } from '../../integrations/paperclip-api.mjs';
import { validateManifest, REVISION, PilotError } from './pilot.mjs';

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const check = (ok) => {
  if (!ok) throw new PilotError('read_qualification_failed');
};
const unavailable = () => ({
  status: 'unavailable',
  code: 'read_qualification_failed',
  readOnly: true,
  executionEnabled: false,
  nativeAuthority: 'unverified',
});

/** Operator-only qualification, never a public endpoint. The caller supplies a
 * separately provisioned Viewer key. No token minting or HTTP mutations exist. */
export function createPilotQualifier(options = {}) {
  const m = validateManifest(options.manifest);
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 4000,
    maxBytes = 1048576,
    apiKey,
    companyId,
    projectId,
    nativeProjectId,
    expectedViewerUserId,
    deniedCompanyId,
    deniedProjectId,
  } = options;
  check(
    typeof fetchImpl === 'function' &&
      Number.isInteger(timeoutMs) &&
      timeoutMs >= 10 &&
      timeoutMs <= 8000 &&
      Number.isInteger(maxBytes) &&
      maxBytes >= 512 &&
      maxBytes <= 1048576,
  );
  if (!apiKey)
    return {
      qualify: async () => ({
        status: 'not-configured',
        readOnly: true,
        executionEnabled: false,
        nativeAuthority: 'unverified',
      }),
    };
  check(
    typeof apiKey === 'string' &&
      /^pcp_board_[a-zA-Z0-9_-]{16,4000}$/.test(apiKey) &&
      [companyId, projectId, deniedCompanyId, deniedProjectId].every(
        (v) => typeof v === 'string' && UUID.test(v),
      ) &&
      companyId !== deniedCompanyId &&
      projectId !== deniedProjectId &&
      typeof expectedViewerUserId === 'string' &&
      /^[a-zA-Z0-9_-]{1,160}$/.test(expectedViewerUserId) &&
      typeof nativeProjectId === 'string' &&
      /^[a-z0-9][a-z0-9-]{0,159}$/.test(nativeProjectId),
  );
  let pending = null;
  async function run(signal) {
    const allowed = new Set([
      '/api/health',
      '/api/cli-auth/me',
      `/api/companies/${companyId}`,
      `/api/companies/${deniedCompanyId}`,
      `/api/projects/${projectId}`,
      `/api/projects/${deniedProjectId}`,
      `/api/companies/${companyId}/members`,
      `/api/companies/${companyId}/agents`,
      `/api/companies/${companyId}/routines`,
      `/api/companies/${companyId}/issues`,
      `/api/companies/${companyId}/costs/by-project`,
    ]);
    const fixedFetch = async (url, init = {}) => {
      const u = new URL(url);
      check(
        !signal.aborted &&
          u.origin === m.origin &&
          !u.username &&
          !u.password &&
          !u.hash &&
          allowed.has(u.pathname) &&
          (init.method ?? 'GET') === 'GET',
      );
      // The bridge may add only its fixed issue-selection query.
      check(
        [...u.searchParams].every(
          ([k, v]) =>
            (k === 'companyId' && v === companyId) ||
            (k === 'projectId' && v === projectId) ||
            (k === 'view' && v === 'index'),
        ),
      );
      const response = await fetchImpl(u.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: 'error',
        signal,
      });
      if (signal.aborted) {
        response.body?.cancel().catch(() => {});
        throw new PilotError('read_qualification_failed');
      }
      if (response.status >= 300 && response.status < 400) {
        response.body?.cancel().catch(() => {});
        throw new PilotError('read_qualification_failed');
      }
      return response;
    };
    const get = async (path, denied = false, anonymous = false) => {
      let response;
      if (anonymous)
        response = await fetchImpl(m.origin + path, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal,
        });
      else response = await fixedFetch(m.origin + path);
      let reader;
      try {
        check(!signal.aborted);
        if (denied) {
          check([401, 403, 404].includes(response.status));
          return;
        }
        check(
          response.ok &&
            /application\/json(?:\s*;|$)/i.test(
              response.headers.get('content-type') ?? '',
            ),
        );
        const length = response.headers.get('content-length');
        check(
          length === null ||
            (/^[0-9]+$/.test(length) && Number(length) <= maxBytes),
        );
        reader = response.body?.getReader();
        check(reader);
        const chunks = [];
        let size = 0;
        while (true) {
          const part = await reader.read();
          check(!signal.aborted);
          if (part.done) break;
          size += part.value.byteLength;
          check(size <= maxBytes);
          chunks.push(part.value);
        }
        return JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } finally {
        if (reader) reader.cancel().catch(() => {});
        else response.body?.cancel().catch(() => {});
      }
    };
    const health = await get('/api/health');
    check(
      health.status === 'ok' &&
        health.commit === REVISION &&
        health.deploymentMode === 'authenticated' &&
        health.deploymentExposure === 'private' &&
        health.authReady === true &&
        health.bootstrapStatus === 'ready',
    );
    const me = await get('/api/cli-auth/me');
    check(
      me.source === 'board_key' &&
        UUID.test(me.keyId ?? '') &&
        me.userId === expectedViewerUserId &&
        me.isInstanceAdmin === false &&
        Array.isArray(me.companyIds) &&
        me.companyIds.length === 1 &&
        me.companyIds[0] === companyId &&
        Array.isArray(me.memberships) &&
        me.memberships.length === 1 &&
        me.memberships[0]?.companyId === companyId &&
        me.memberships[0]?.status === 'active' &&
        me.memberships[0]?.membershipRole === 'viewer',
    );
    const company = await get(`/api/companies/${companyId}`);
    check(company.id === companyId);
    const project = await get(`/api/projects/${projectId}`);
    check(
      project.id === projectId &&
        project.companyId === companyId &&
        project.visibility === 'private' &&
        project.status === 'backlog' &&
        project.leadAgentId === null,
    );
    for (const family of ['agents', 'routines']) {
      const rows = await get(`/api/companies/${companyId}/${family}`);
      check(Array.isArray(rows) && rows.length === 0);
    }
    await get(`/api/companies/${companyId}/members`, true);
    await get(`/api/companies/${deniedCompanyId}`, true);
    await get(`/api/projects/${deniedProjectId}`, true);
    await get(`/api/companies/${companyId}`, true, true);
    // Materialize every real read under this qualifier's retained actual-job
    // slot. The bridge's own timeout must not free admission while a transport
    // that ignores abort is still fetching/streaming data.
    const documents = new Map([[`/api/projects/${projectId}`, project]]);
    for (const family of ['issues', 'costs/by-project'])
      documents.set(
        `/api/companies/${companyId}/${family}`,
        await get(
          `/api/companies/${companyId}/${family}` +
            (family === 'issues' ? `?projectId=${projectId}&view=index` : ''),
        ),
      );
    const materializedFetch = async (url, init) => {
      const u = new URL(url);
      check(
        !signal.aborted &&
          init.method === 'GET' &&
          u.origin === m.origin &&
          documents.has(u.pathname),
      );
      return new Response(JSON.stringify(documents.get(u.pathname)), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const bridge = createPaperclipReadBridge({
      origin: m.origin,
      allowedOrigins: [m.origin],
      allowLoopback: true,
      apiKey,
      allowedCompanyIds: [companyId],
      projectMap: { [nativeProjectId]: { companyId, projectId } },
      fetchImpl: materializedFetch,
      timeoutMs,
      maxBytes,
      cacheMs: 0,
      maxConcurrent: 1,
    });
    const operations = await bridge.project(nativeProjectId);
    check(
      !signal.aborted &&
        operations.status === 'available' &&
        operations.tasks.status === 'available' &&
        operations.tasks.count === 0 &&
        operations.manager.status === 'not-assigned' &&
        ['not-reported', 'available'].includes(operations.costs.status),
    );
    return {
      status: 'qualified-read-only',
      readOnly: true,
      executionEnabled: false,
      nativeAuthority: 'unverified',
      ownershipMapping: 'operator_supplied_not_attested',
      sourceRevision: REVISION,
      evidence: {
        exactViewerIdentity: true,
        singleCompanyViewer: true,
        privateProjectReadable: true,
        emptyAgentAndRoutineLists: true,
        anonymousCompanyDenied: true,
        crossCompanyProbeDenied: true,
        crossProjectProbeDenied: true,
        // A refusal against an unknown UUID does not prove an existing tenant
        // or private object was isolated. Bind owner-readable fixtures in a
        // separate qualification before claiming those stronger properties.
        crossTenantIsolationVerified: false,
        privateAclIsolationVerified: false,
        explicitGrantInventoryVerified: false,
        permissionAdministrationProbeDenied: true,
        writeDenialTested: false,
      },
      operations,
    };
  }
  return {
    qualify() {
      if (pending) return pending.response;
      const entry = {},
        controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PilotError('read_qualification_failed'));
        }, timeoutMs);
      });
      const job = Promise.resolve().then(() => run(controller.signal));
      entry.response = Promise.race([job, timeout])
        .catch(unavailable)
        .finally(() => clearTimeout(timer));
      pending = entry;
      // A timeout bounds the caller, not the underlying work. Retain the single
      // slot/rejected response until actual settlement, including ignored aborts.
      const release = () => {
        if (pending === entry) pending = null;
      };
      job.then(release, release);
      return entry.response;
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const file = await readFile(process.argv[2]);
    check(file.length <= 32768);
    const config = JSON.parse(file);
    check(
      Object.keys(config).every((k) =>
        [
          'companyId',
          'projectId',
          'nativeProjectId',
          'expectedViewerUserId',
          'deniedCompanyId',
          'deniedProjectId',
        ].includes(k),
      ),
    );
    const manifest = JSON.parse(
      await readFile(new URL('./runtime-manifest.json', import.meta.url)),
    );
    const out = await createPilotQualifier({
      ...config,
      manifest,
      apiKey: process.env.BAINK_PAPERCLIP_API_KEY,
    }).qualify();
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (out.status !== 'qualified-read-only') process.exitCode = 2;
  } catch {
    process.stderr.write(
      JSON.stringify({ error: 'read_qualification_failed' }) + '\n',
    );
    process.exitCode = 1;
  }
}
