// Work and central-earning routes: the public project catalogue and unified
// work list, work sources and selections, the current work and claim records,
// the native project pilot, bounty materials, central five-KPI earning and
// the public-review checker (member submissions and its worker endpoints).
import { fail } from "../http-errors.mjs";
import { HANDLED, only } from "./context.mjs";

const WORK_SELECTION_PATH = /^\/api\/work\/selections\/([a-f0-9-]{36})\/withdraw$/;
const PROJECT_PILOT_PATH = /^\/api\/native\/project-pilot\/([a-f0-9-]{36})\/(submit|receipt|publish|recover)$/;
const CENTRAL_SUBMISSION_PATH = /^\/api\/native\/central\/submissions\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})$/;
const CENTRAL_TASK_PATH = /^\/api\/native\/central\/tasks\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})$/;
const CENTRAL_INTENT_PATH = /^\/api\/native\/central\/intents\/([a-f0-9-]{36})\/(submit|reconcile)$/;
const MATERIALS_PATH = /^\/api\/native\/earning\/materials(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,95}))?$/;
const REVIEW_PATH = /^\/api\/native\/review\/([a-f0-9]{32})(?:\/artifact\/(certificate|review|relay))?$/;
const REVIEW_ACTION_PATH = /^\/api\/native\/review\/([a-f0-9]{32})\/(recover|abandon)$/;

const projectPilotOperation = ({ method, path }) =>
  (method === "GET" && path === "/api/native/project-pilot") ||
  (method === "POST" && ["/api/native/project-pilot/prepare", "/api/native/project-pilot/snapshot"].includes(path)) ||
  (method === "POST" && PROJECT_PILOT_PATH.test(path));
const centralOperation = ({ method, path }) =>
  (method==="GET"&&(["/api/native/central/status","/api/native/central/awards","/api/native/central/tasks","/api/native/central/intents"].includes(path)||CENTRAL_TASK_PATH.test(path)||CENTRAL_SUBMISSION_PATH.test(path)))||(method==="POST"&&(path==="/api/native/central/prepare"||CENTRAL_INTENT_PATH.test(path)));
const materialsOperation = ({ method, path }) =>
  method === "GET" && MATERIALS_PATH.test(path);
const reviewOperation = ({ method, path }) =>
  (method === "POST" && (path === "/api/native/review" || REVIEW_ACTION_PATH.test(path))) || (method === "GET" && (path === "/api/native/review/lookup" || REVIEW_PATH.test(path)));

export function createWorkRoutes({
  store,
  publicReview,
  reviewCall,
  publicProjects,
  projectDetails,
  unifiedWork,
  workSelections,
  nativeWorkClaim,
  nativeWorkCurrent,
  nativeProjectPilot,
  nativeBountyMaterials,
  centralEarning,
}) {
  return {
    name: "work",
    async public(ctx) {
      const { req, method, path, url, body } = ctx;
      if (method === "GET" && path === "/api/native/review/health")
        return ctx.send(200, publicReview ? await publicReview.health() : {configured: false, available: false, publicKey: null});
      if (method === "POST" && /^\/api\/native\/review-worker\/(claim|complete|health)$/.test(path))
        return ctx.send(200, await reviewCall(() => publicReview.worker({method, path, body, headers: req.headers}), true));
      if (method === "GET" && path === "/api/projects")
        return ctx.send(200, await publicProjects(url.searchParams));
      const projectPath = path.match(/^\/api\/projects\/([a-z0-9-]{1,160})$/);
      if (method === "GET" && projectPath)
        return ctx.send(200, await projectDetails(projectPath[1]));
      if (method === "GET" && path === "/api/work/projects") {
        only(body, []);
        return ctx.send(200, await unifiedWork.list(url.searchParams));
      }
      if (method === "GET" && path === "/api/work/source") {
        const query = ctx.query();
        only(query, ["kind", "projectId"]);
        return ctx.send(200, await workSelections.review(query.kind, query.projectId));
      }
    },
    isPrivate(ctx) {
      const { method, path } = ctx;
      return Boolean(
        projectPilotOperation(ctx) ||
        centralOperation(ctx) ||
        reviewOperation(ctx) ||
        materialsOperation(ctx) ||
        (path === "/api/work/current" && method === "GET") ||
        (path === "/api/work/claim" && method === "GET") ||
        (path === "/api/work/selections" && ["GET", "POST"].includes(method)) ||
        (WORK_SELECTION_PATH.test(path) && method === "POST"),
      );
    },
    async private(ctx) {
      const { method, path, body, user } = ctx;
      if (projectPilotOperation(ctx)) {
        const projectPilotPath = path.match(PROJECT_PILOT_PATH);
        only(ctx.query(), []);
        if (!store.hasAccount(user.address)) fail(403, "account_required", "Create your BAINK account first.");
        if (method === "GET") { only(body, []); return ctx.send(200, nativeProjectPilot.list(user)); }
        if (path.endsWith("/snapshot")) return ctx.send(200, await nativeProjectPilot.snapshot(user, body));
        if (path.endsWith("/prepare")) {
          const result = await nativeProjectPilot.prepare(user, body);
          return ctx.send(result.created ? 201 : 200, result);
        }
        return ctx.send(200, await nativeProjectPilot[projectPilotPath[2]](user, projectPilotPath[1], body));
      }
      if (path === "/api/work/claim") {
        only(body, []);
        const account = store.account(user.address);
        if (
          !account ||
          account.address !== user.address ||
          account.publicKey !== user.publicKey
        )
          fail(
            503,
            "claim_read_unavailable",
            "The selected claim record is unavailable.",
          );
        return ctx.send(200, await nativeWorkClaim.get(user, ctx.query()));
      }
      if (path === "/api/work/current") {
        only(body, []);
        const account = store.account(user.address);
        if (
          !account ||
          account.address !== user.address ||
          account.publicKey !== user.publicKey
        )
          fail(
            503,
            "current_work_unavailable",
            "The current work record is unavailable.",
          );
        return ctx.send(200, await nativeWorkCurrent.get(user, ctx.query()));
      }
      if (path === "/api/work/selections")
        return ctx.send(
          method === "GET" ? 200 : 201,
          method === "GET"
            ? await workSelections.list(user, ctx.query())
            : await workSelections.select(user, body),
        );
      const workSelectionPath = path.match(WORK_SELECTION_PATH);
      if (workSelectionPath)
        return ctx.send(
          200,
          await workSelections.withdraw(user, workSelectionPath[1], body),
        );
    },
    async member(ctx) {
      const { res, method, path, body, user } = ctx;
      if (reviewOperation(ctx)) {
        if (method === "GET" && path === "/api/native/review/lookup") {
          only(body, []);
          const query = ctx.query();
          only(query, ["contextDigest", "createRequestDigest"]);
          if (![query.contextDigest, query.createRequestDigest].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)))
            fail(400, "invalid_query", "Use the exact original context and create-request digests.");
          return ctx.send(200, await reviewCall(() => publicReview.lookup(user, {contextDigest: query.contextDigest, createRequestDigest: query.createRequestDigest})));
        }
        const reviewPath = path.match(REVIEW_PATH);
        const reviewActionPath = path.match(REVIEW_ACTION_PATH);
        only(ctx.query(), []);
        if (method === "GET") { only(body, []); return ctx.send(200, await reviewCall(() => reviewPath[2] ? publicReview.artifact(user, reviewPath[1], reviewPath[2]) : publicReview.status(user, reviewPath[1]))); }
        if (reviewActionPath) { only(body, []); return ctx.send(200, await reviewCall(() => publicReview[reviewActionPath[2]](user, reviewActionPath[1]))); }
        return ctx.send(202, await reviewCall(() => publicReview.submit(user, body)));
      }
      if (materialsOperation(ctx)) {
        const materialsPath = path.match(MATERIALS_PATH);
        only(ctx.query(), []);
        only(body, []);
        if (!materialsPath[1]) return ctx.send(200, await nativeBountyMaterials.list(user));
        const material = await nativeBountyMaterials.get(user, materialsPath[1]);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": material.bytes.length,
          "Content-Disposition": `attachment; filename="${material.filename}"`,
          "Cache-Control": "private, no-store",
          "Pragma": "no-cache",
          "X-BAINK-Source-SHA256": material.sourceSha256,
        });
        res.end(material.bytes);
        return HANDLED;
      }
      if (centralOperation(ctx)) {
        const centralTaskPath = path.match(CENTRAL_TASK_PATH);
        const centralSubmissionPath = path.match(CENTRAL_SUBMISSION_PATH);
        const centralIntentPath = path.match(CENTRAL_INTENT_PATH);
        const query=ctx.query();
        if(method==="GET"){
          only(body,[]);
          // Only authenticated proof reads may wait for the bounded central queue.
          if(path!=="/api/native/central/intents")ctx.extendDeadline(28_000);
          if(path==="/api/native/central/tasks"){
            only(query,["cursor","limit","order","state"]);
            if(query.limit!==undefined&&!/^(?:[1-9]|1[0-2])$/.test(query.limit))fail(400,"invalid_query","Use a page size from 1 to 12.");
            // order=newest lists the newest task first; state=open returns only tasks open for work now.
            if(query.order!==undefined&&!["index","newest"].includes(query.order))fail(400,"invalid_query","Use order=index or order=newest.");
            if(query.state!==undefined&&!["all","open"].includes(query.state))fail(400,"invalid_query","Use state=all or state=open.");
            return ctx.send(200,await centralEarning.tasks(user,{...(query.cursor!==undefined?{cursor:query.cursor}:{}),...(query.limit!==undefined?{limit:Number(query.limit)}:{}),...(query.order!==undefined?{order:query.order}:{}),...(query.state!==undefined?{state:query.state}:{})}));
          }
          if(path==="/api/native/central/awards"){
            only(query,["cursor","limit"]);
            if(query.cursor!==undefined&&!/^(?:0|[1-9][0-9]{0,19})$/.test(query.cursor))fail(400,"invalid_query","Use an award cursor from a previous page.");
            if(query.limit!==undefined&&!/^(?:[1-9]|[1-4][0-9]|50)$/.test(query.limit))fail(400,"invalid_query","Use a page size from 1 to 50.");
            return ctx.send(200,await centralEarning.awards(user,{...(query.cursor!==undefined?{cursor:query.cursor}:{}),...(query.limit!==undefined?{limit:Number(query.limit)}:{})}));
          }
          if(centralSubmissionPath){only(query,['executionId']);return ctx.send(200,await centralEarning.submission(user,centralSubmissionPath[1],query));}
          // Bounded reads of the member's own steps (12 November 2026): limit (newest first) or one id.
          // Without a query the full list is unchanged, for the kit.
          if(path==="/api/native/central/intents"&&Object.keys(query).length){
            only(query,["limit","id"]);
            if(query.limit!==undefined&&!/^(?:[1-9]|[1-4][0-9]|50)$/.test(query.limit))fail(400,"invalid_query","Use a page size from 1 to 50.");
            if(query.id!==undefined&&!/^[a-f0-9-]{36}$/.test(query.id))fail(400,"invalid_query","Use the id of one of your steps.");
            if(query.limit!==undefined&&query.id!==undefined)fail(400,"invalid_query","Ask for one step by id, or for the newest steps with limit, not both.");
            return ctx.send(200,centralEarning.list(user,{...(query.limit!==undefined?{limit:Number(query.limit)}:{}),...(query.id!==undefined?{id:query.id}:{})}));
          }
          only(query,[]);
          return ctx.send(200,centralTaskPath?await centralEarning.task(user,centralTaskPath[1]):path==="/api/native/central/status"?await centralEarning.status(user):centralEarning.list(user));
        }
        only(query,[]);
        const result=centralIntentPath?await centralEarning[centralIntentPath[2]](user,centralIntentPath[1],body):await centralEarning.prepare(user,body);
        return ctx.send(result.created?201:result.attempted?202:200,result);
      }
    },
  };
}
