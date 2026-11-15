/** Prior-art survey drafts (the first task of every UAIN project organization).
 *
 * A newcomer writes plain lines; this turns them into the canonical evidence artifact the
 * fixed prior-art-survey verifier reads (services/project-organizations/verifiers/
 * prior-art-survey.mjs): {author, schema, submissionId, survey, taskId}, sorted-key JSON.
 * Nothing here decides acceptance: the verifier resolves every identifier and the
 * independent checker reviews it. */

const bytes = (v) => new TextEncoder().encode(v).length;
export const SURVEY_TASK = /^T-OPP-[0-9]{5}-1-prior-art-survey$/;
export const KINDS = ["doi", "arxiv", "github", "pubmed", "nct", "wikidata"];
export const RELATIONS = ["meets_main_kpi", "partial", "adjacent", "screened_out"];

/** Sorted-key JSON, the same canonical form as services/project-organizations/src/common.mjs. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

/** Canonical identifier form (the verifier refuses any other spelling). */
export function normalizeId(kind, id) {
  let v = String(id ?? "").trim();
  if (kind === "doi") v = v.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
  if (kind === "arxiv") v = v.replace(/^arxiv:/i, "").toLowerCase().replace(/v[0-9]{1,3}$/, "");
  if (kind === "github") v = v.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase();
  if (kind === "nct" || kind === "wikidata") v = v.toUpperCase();
  return v;
}

/** The starting text for a survey task, from its public template. */
export function surveyTemplateText(template, today = new Date().toISOString().slice(0, 10)) {
  const lines = [
    "# Prior-art survey: report the work that already exists for this Main KPI.",
    `# Main KPI: ${template.mainKpi}`,
    "# One line per item:  item: kind | id | title of the record | relation | note",
    `# kind: ${KINDS.join(", ")}   relation: ${RELATIONS.join(", ")}`,
    "# Use the record's exact title. Each identifier is checked against its public record.",
    `asOf: ${today}`,
    "",
    "# Keep every identifier below (they came from the project's own searches): screen it out with a",
    "# reason, or say how it relates to the Main KPI.",
    ...template.required.map((r) => `item: ${r.kind} | ${r.id} | ${r.title || "TITLE OF THE RECORD"} | screened_out | Why it does not bear on the Main KPI.`),
    "",
    `# Add at least ${template.minIncluded} items that are not screened out, from at least ${template.minKinds} kinds. For example:`,
    "# item: pubmed | 12345678 | The title exactly as PubMed lists it | partial | What it achieves for the Main KPI and what it leaves undone.",
    "",
    "gap: What existing work leaves undone for the Main KPI (20 to 600 characters).",
    "meetsMainKpi: no",
  ];
  return lines.join("\n") + "\n";
}

/** Plain lines -> survey object, with readable errors. */
export function parseSurveyDraft(text, template) {
  const items = [], gaps = [], errors = [];
  let asOf = null, meets = null;
  String(text ?? "").split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const at = `Line ${n + 1}`;
    const m = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return errors.push(`${at}: start with item:, gap:, asOf: or meetsMainKpi:`);
    const [, key, rest] = m;
    if (key === "asOf") asOf = rest.trim();
    else if (key === "meetsMainKpi") meets = /^(yes|true)$/i.test(rest.trim()) ? true : /^(no|false)$/i.test(rest.trim()) ? false : (errors.push(`${at}: meetsMainKpi is yes or no`), null);
    else if (key === "gap") {
      const gap = rest.trim();
      if (bytes(gap) < 20 || bytes(gap) > 600) return errors.push(`${at}: a gap is 20 to 600 characters`);
      gaps.push(gap);
    }
    else if (key === "item") {
      const parts = rest.split("|").map((p) => p.trim());
      if (parts.length !== 5) return errors.push(`${at}: an item has five parts separated by |`);
      const [kind, id, title, relation, note] = parts;
      if (!KINDS.includes(kind)) return errors.push(`${at}: unknown kind ${kind}`);
      if (!RELATIONS.includes(relation)) return errors.push(`${at}: unknown relation ${relation}`);
      if (/^TITLE OF THE RECORD$/.test(title)) return errors.push(`${at}: write the record's title`);
      if (bytes(title) < 3 || bytes(title) > 300) return errors.push(`${at}: the title is 3 to 300 characters`);
      if (bytes(note) < 10 || bytes(note) > 400) return errors.push(`${at}: the note is 10 to 400 characters`);
      items.push({ kind, id: normalizeId(kind, id), title, relation, note });
    } else errors.push(`${at}: unknown field ${key}`);
  });
  if (items.length > 60) errors.push("Use at most 60 items");
  if (gaps.length > 12) errors.push("Use at most 12 gap: lines");
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) errors.push("asOf: give the survey date as YYYY-MM-DD");
  if (meets === null) errors.push("meetsMainKpi: say yes or no");
  if (meets === true && !items.some((i) => i.relation === "meets_main_kpi")) errors.push("meetsMainKpi is yes, so mark the item that meets it as meets_main_kpi");
  if (meets === false && items.some((i) => i.relation === "meets_main_kpi")) errors.push("An item is marked meets_main_kpi, so meetsMainKpi must be yes");
  if (meets === false && !gaps.length) errors.push("Add at least one gap: line");
  const included = items.filter((i) => i.relation !== "screened_out");
  if (template && included.length < template.minIncluded) errors.push(`Add at least ${template.minIncluded} items that are not screened out (now ${included.length})`);
  if (template && new Set(included.map((i) => i.kind)).size < template.minKinds) errors.push(`Use at least ${template.minKinds} kinds of source among included items`);
  for (const r of template?.required ?? []) if (!items.some((i) => i.kind === r.kind && i.id === r.id)) errors.push(`Keep the item ${r.kind} ${r.id}`);
  if (errors.length) return { errors };
  return { survey: { mainKpi: template.mainKpi, asOf, items, conclusion: { meetsMainKpi: meets, gaps } } };
}

/** The exact evidence string for central_submit: the canonical artifact naming this submission. */
export function surveyEvidence({ taskId, submissionId, author, survey }) {
  return canonical({ author, schema: "uain-evidence-artifact-v1", submissionId, survey, taskId });
}
