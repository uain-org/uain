// Public routes that need no account: service health, the public
// configuration, the funding policy and the prior-art survey templates.
import { readFileSync } from "node:fs";
import { fail } from "../http-errors.mjs";
import { projectFundingReadiness } from "../funding-policy.mjs";
import { only } from "./context.mjs";
import { SURVEY_PART_TASK, surveyPartTemplate } from "../survey-part-template.mjs";

const SETTLEMENT = {
  available: false,
  code: "settlement_requires_native_readiness",
  message:
    "Check the current native account proof for asset and settlement readiness.",
};

// Derived survey-part templates: positive results are kept (a task's criteria never change),
// refusals briefly, and only a few native reads run at once on this unauthenticated route.
const DERIVED_MAX = 1024, REFUSED_MAX = 1024, REFUSED_MS = 30_000, FLIGHTS_MAX = 8;
const remember = (map, key, value, max) => {
  map.delete(key);
  while (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
};

export function createPublicRoutes({ publicConfig, centralEarning = null, publicTasks = null, reviewQueue = null, admitPublic = null, now = Date.now }) {
  // Survey templates (services/project-organizations/ops/survey-templates.mjs), read once.
  let surveyTemplateCache = null;
  const surveyTemplates = () => {
    if (surveyTemplateCache === null) {
      try {
        const file = JSON.parse(readFileSync(new URL("../survey-templates.json", import.meta.url), "utf8"));
        surveyTemplateCache = file?.schema === "baink-survey-templates-v1" && file.templates && typeof file.templates === "object" ? file.templates : {};
      } catch {
        surveyTemplateCache = {};
      }
    }
    return surveyTemplateCache;
  };
  // A survey part with no static row: read its proved native task and derive the template
  // from the criteria (survey-part-template.mjs). null when it is not a derivable open part.
  const derived = new Map(), refused = new Map(), flights = new Map();
  async function derivedSurveyTemplate(taskId) {
    if (derived.has(taskId)) return derived.get(taskId);
    if (refused.has(taskId)) {
      if (now() < refused.get(taskId)) return null;
      refused.delete(taskId);
    }
    if (typeof centralEarning?.publicTask !== "function") return null;
    let flight = flights.get(taskId);
    if (!flight) {
      if (flights.size >= FLIGHTS_MAX) fail(503, "survey_template_busy", "Survey templates are busy. Try again shortly.");
      flight = (async () => {
        const read = await centralEarning.publicTask(taskId);
        const template = read?.authority === "native" && read.verified === true ? surveyPartTemplate(taskId, read.task) : null;
        if (template) remember(derived, taskId, template, DERIVED_MAX);
        else remember(refused, taskId, now() + REFUSED_MS, REFUSED_MAX);
        return template;
      })().finally(() => flights.delete(taskId));
      flights.set(taskId, flight);
    }
    return flight;
  }
  return {
    name: "public",
    async public(ctx) {
      const { method, path } = ctx;
      if (method === "GET" && (path === "/api/health" || path === "/api/status"))
        return ctx.send(200, {
          ok: true,
          service: "baink",
          storage: "ready",
          settlement: SETTLEMENT,
        });
      const surveyTemplatePath = path.match(/^\/api\/native\/central\/survey-template\/(T-OPP-[0-9]{5}-1-prior-art-survey(?:-r[2-9]-p[1-9][0-9]?)?)$/);
      if (method === "GET" && surveyTemplatePath) {
        // Public: what a prior-art survey (or survey part) submission must contain (no account needed).
        // Static rows keep priority; a part without one is derived from its native task.
        const template = surveyTemplates()[surveyTemplatePath[1]] ??
          (SURVEY_PART_TASK.test(surveyTemplatePath[1]) ? await derivedSurveyTemplate(surveyTemplatePath[1]) : null);
        if (!template) fail(404, "survey_template_missing", "This task has no published survey template.");
        return ctx.send(200, { taskId: surveyTemplatePath[1], ...template });
      }
      if (method === "GET" && path === "/api/public/tasks" && publicTasks) {
        // Public and unsigned: search and page the shared proved open-task snapshot.
        const query = ctx.query();
        only(query, ['q', 'project', 'cursor', 'limit']);
        let list;
        try { list = await publicTasks.list({ ...query, ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) }); }
        catch (error) { if (error?.code === 'invalid_query') fail(400, 'invalid_query', error.message); throw error; }
        if (list.status !== "available") { if (list.warming) return ctx.send(503, { ...list, error: { code: "tasks_warming", message: list.note } }); fail(503, "tasks_unavailable", list.note); }
        return ctx.send(200, list);
      }
      const contributionPath = path.match(/^\/api\/public\/contribution\/(uain1[a-f0-9]{40})$/);
      if (method === "GET" && contributionPath && typeof centralEarning?.contribution === "function") {
        // Public and unsigned: one member's contribution points (Karma), accepted work and ledger
        // facts (shared/contribution-view.mjs). Everything on the platform is public (K-38).
        only(ctx.query(), []);
        admitPublic?.(ctx);
        ctx.extendDeadline(28_000);
        const view = await centralEarning.contribution(contributionPath[1]);
        if (!view) fail(503, "contribution_unavailable", "Contribution records are not available on this server.");
        return ctx.send(200, view);
      }
      if (method === "GET" && path === "/api/public/review-queue" && reviewQueue) {
        // Public and unsigned: how many submissions wait for the reviewer, and its hourly limit (review-queue.mjs).
        only(ctx.query(), []);
        return ctx.send(200, await reviewQueue.figure());
      }
      if (method === "GET" && path === "/api/config")
        return ctx.send(200, await publicConfig(ctx.requestAudience));
      if (method === "GET" && path === "/api/funding/policy") {
        only(ctx.query(), []);
        only(ctx.body, []);
        return ctx.send(200, projectFundingReadiness());
      }
    },
  };
}
