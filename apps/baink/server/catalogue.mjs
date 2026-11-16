import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SHA = "4419baef812bde5e33718e5e6acc76e1d7dde6fc95574ba79cd0c66955feb5d2";
const REPOSITORY = "https://github.com/nuah-org/uain-project-incubator";
const NOTICE =
  "Source proposals only. Active work, novelty review, leadership, funding and AI$ earnings are not established.";
const valid = (condition, why) => {
  if (!condition) throw new Error(why);
};
async function jsonFile(path, maxBytes, sha256) {
  valid(
    (await stat(path)).size <= maxBytes,
    "Catalogue file exceeds its size bound",
  );
  const bytes = await readFile(path);
  if (sha256)
    valid(
      createHash("sha256").update(bytes).digest("hex") === sha256,
      "Catalogue file failed its integrity check",
    );
  return JSON.parse(bytes.toString("utf8"));
}
function paging({ page = 1, pageSize = 24 } = {}) {
  return {
    page: Math.min(10000, Math.max(1, parseInt(page, 10) || 1)),
    pageSize: Math.min(100, Math.max(1, parseInt(pageSize, 10) || 24)),
  };
}
function unavailable(diagnostic) {
  const source = {
    status: "unavailable",
    kind: "source-proposals",
    notice: NOTICE,
  };
  return {
    available: false,
    diagnostic,
    list: (options) => ({
      projects: [],
      total: 0,
      catalogueTotal: 0,
      ...paging(options),
      pages: 0,
      domains: [],
      source,
    }),
    detail: () => null,
    publicSummaryIndex: () => ({ records: [], domains: [], source }),
  };
}

export async function loadCatalogue(directory) {
  if (!directory) return unavailable("Catalogue directory not configured");
  try {
    let hashes = null;
    try {
      hashes = await jsonFile(join(directory, "checksums.json"), 20_000);
      valid(
        hashes &&
          typeof hashes === "object" &&
          !Array.isArray(hashes) &&
          Object.keys(hashes).length === 46 &&
          Object.values(hashes).every(
            (value) =>
              typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
          ),
        "Invalid catalogue integrity manifest",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let index,
      indexFile = "index.json";
    try {
      index = await jsonFile(
        join(directory, indexFile),
        100_000,
        hashes?.[indexFile],
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      indexFile = "inactive.json";
      index = await jsonFile(
        join(directory, indexFile),
        100_000,
        hashes?.[indexFile],
      );
    }
    if (hashes)
      valid(
        Boolean(hashes[indexFile]),
        "Catalogue index omitted from integrity manifest",
      );
    valid(
      index?.schema === "uain/inactive-project-catalogue/v1" &&
        index.count === 21600,
      "Invalid catalogue schema or count",
    );
    valid(
      index.source?.repository === REPOSITORY &&
        index.source?.workbook_sha256 === SHA &&
        /^[a-f0-9]{40}$/.test(index.source?.revision ?? ""),
      "Unrecognized catalogue provenance",
    );
    valid(
      Array.isArray(index.domains) && index.domains.length === 45,
      "Expected 45 catalogue domains",
    );
    const domains = [],
      records = [],
      byId = new Map(),
      rows = new Set(),
      domainNames = new Set();
    let opportunities = 0,
      problems = 0;
    for (let i = 0; i < 45; i++) {
      const domain = index.domains[i];
      valid(
        domain?.id === String(i + 1) &&
          typeof domain.name === "string" &&
          domain.name.length > 0 &&
          domain.name.length <= 200 &&
          domain.count === 480 &&
          domain.file === `domain-${i + 1}.json` &&
          !domainNames.has(domain.name),
        "Invalid domain metadata",
      );
      domainNames.add(domain.name);
      domains.push({ id: domain.id, name: domain.name, count: domain.count });
      if (hashes)
        valid(
          Boolean(hashes[domain.file]),
          "Domain omitted from integrity manifest",
        );
      const projects = await jsonFile(
        join(directory, domain.file),
        1_000_000,
        hashes?.[domain.file],
      );
      valid(
        Array.isArray(projects) && projects.length === domain.count,
        "Domain count does not match its records",
      );
      for (const row of projects) {
        const match =
          typeof row?.id === "string" && row.id.match(/^(OPP|PRB)-(\d{5})$/);
        valid(
          match &&
            Number(match[2]) >= 1 &&
            Number(match[2]) <= 10800 &&
            !byId.has(row.id),
          "Invalid or duplicate project identifier",
        );
        const fields = row.source_fields,
          provenance = row.provenance;
        valid(
          typeof row.title === "string" &&
            row.title.length > 0 &&
            row.title.length <= 1000 &&
            typeof row.summary === "string" &&
            row.summary.length <= 2000 &&
            typeof row.kpi === "string" &&
            row.kpi.length <= 2000,
          "Invalid proposal text",
        );
        valid(
          row.status === "inactive" && row.progress === null,
          "Catalogue contains an active or measured proposal",
        );
        valid(
          fields?.ID === row.id &&
            fields.Item === row.title &&
            fields["Domain #"] === i + 1 &&
            fields.Domain === domain.name &&
            fields.List ===
              (match[1] === "OPP" ? "Opportunity" : "Problem to solve"),
          "Proposal does not match source fields",
        );
        valid(
          provenance?.source_sha256 === SHA &&
            provenance.sheet === "All items" &&
            Number.isInteger(provenance.row) &&
            provenance.row >= 2 &&
            provenance.row <= 21601 &&
            !rows.has(provenance.row),
          "Invalid or duplicate source row provenance",
        );
        valid(
          row.crew?.namespace === row.id &&
            row.crew.planned_slots === 100 &&
            row.crew.assigned_agents === 0 &&
            row.crew.connected === false,
          "Catalogue must not claim assigned or connected workers",
        );
        const threshold = fields["KPI number"],
          unit = fields["KPI unit / what is counted"];
        valid(
          (threshold === null ||
            (typeof threshold === "number" && Number.isFinite(threshold))) &&
            typeof unit === "string" &&
            unit.length <= 2000,
          "Invalid source KPI",
        );
        rows.add(provenance.row);
        if (match[1] === "OPP") opportunities++;
        else problems++;
        const kpi = {
          statement: row.kpi,
          threshold,
          unit,
          comparator: null,
          qualification:
            "Ambitious source-proposal target; not a measured result.",
        };
        const summary = {
          id: row.id,
          title: row.title,
          description: row.summary,
          category: domain.name,
          domainId: domain.id,
          status: "inactive",
          operationalStatus: "not_started",
          url: null,
          taskCount: 0,
          kind: fields.List,
          kpi,
        };
        const detail = {
          ...summary,
          goal: row.title,
          lead: null,
          progress: null,
          stopConditions: [],
          ceoChat: { available: false, status: "unavailable" },
          tasks: [],
          tasksAvailable: false,
          achievedWork: [],
          provenance: {
            source_sha256: provenance.source_sha256,
            sheet: provenance.sheet,
            row: provenance.row,
          },
          crew: {
            plannedSlots: row.crew.planned_slots,
            assignedAgents: 0,
            connected: false,
          },
          settlementAvailable: false,
          notice: NOTICE,
        };
        const record = {
          summary,
          detail,
          haystack:
            `${row.id} ${row.title} ${row.summary} ${row.kpi} ${fields.List}`.toLowerCase(),
        };
        records.push(record);
        byId.set(row.id, record);
      }
    }
    valid(
      records.length === 21600 &&
        opportunities === 10800 &&
        problems === 10800 &&
        rows.size === 21600,
      "Catalogue totals do not match the approved export",
    );
    const source = {
      status: "available",
      kind: "source-proposals",
      repository: REPOSITORY,
      revision: index.source.revision,
      workbookSha256: SHA,
      validatedCount: records.length,
      domainCount: domains.length,
      integrity: hashes ? "sha256-verified" : "schema-and-provenance-verified",
      notice: NOTICE,
    };
    // Reuse the validated summaries/search text. Unified discovery must not
    // fetch 21,600 detail records or run one management query per proposal.
    const publicIndex = Object.freeze({
      records: Object.freeze(records.map((row) => Object.freeze({
        summary: row.summary, searchText: row.haystack,
      }))),
      domains, source,
    });
    return {
      available: true,
      publicSummaryIndex: () => publicIndex,
      list(options = {}) {
        const { page, pageSize } = paging(options);
        const q = String(options.q ?? options.search ?? "")
          .trim()
          .toLowerCase()
          .slice(0, 200);
        const domain = String(options.domain ?? "")
          .trim()
          .toLowerCase()
          .slice(0, 200);
        const filtered = records.filter(
          (row) =>
            (typeof options.filterProject !== "function" ||
              options.filterProject(row.summary)) &&
            (!q || row.haystack.includes(q)) &&
            (!domain ||
              domain === "all" ||
              row.summary.domainId === domain ||
              row.summary.category.toLowerCase() === domain),
        );
        return {
          projects: filtered
            .slice((page - 1) * pageSize, page * pageSize)
            .map((row) => row.summary),
          total: filtered.length,
          catalogueTotal: records.length,
          page,
          pageSize,
          pages: Math.ceil(filtered.length / pageSize),
          domains,
          source,
        };
      },
      detail(id) {
        const record = byId.get(id);
        return record ? { project: record.detail, source } : null;
      },
    };
  } catch (error) {
    return unavailable(error.message);
  }
}
