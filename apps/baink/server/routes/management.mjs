// Management and proposal routes: the source-proposal catalogue, project
// coordination (status, batches, chat, evidence, initial tasks), the private
// fleet and project-operations projections, and SmartMeet meetings.
import { fail } from "../http-errors.mjs";
import { OrganizationsStatusError } from "../organizations-status.mjs";
import { only } from "./context.mjs";

const MANAGEMENT_PATH =
  /^\/api\/management\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})(?:\/(chat|evidence))?$/;
const OPERATIONS_PATH =
  /^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})\/operations$/;

const managementWrite = (ctx, managementPath = ctx.path.match(MANAGEMENT_PATH)) =>
  managementPath &&
  ["chat", "evidence"].includes(managementPath[2]) &&
  ["GET", "POST"].includes(ctx.method);

export function createManagementRoutes({
  options,
  store,
  management,
  proposals,
  proposalPages,
  managedProposals,
  currentManagedProject,
  initialProjectTasks,
  organizationsStatus,
  paperclip,
  disconnectedPaperclip,
  operationsViewers,
  operationsNativeLeads,
  nativeProjectAccess,
  smartmeet,
  smartmeetMembers,
}) {
  return {
    name: "management",
    async public(ctx) {
      const { method, path, url, body } = ctx;
      if (method === "GET" && path === "/api/proposals") {
        const result = management.decorate(
          proposalPages.decorate(
            managedProposals(Object.fromEntries(url.searchParams)),
          ),
        );
        return ctx.send(
          proposals.available ? 200 : 503,
          proposals.available
            ? result
            : {
                ...result,
                error: {
                  code: "catalogue_unavailable",
                  message:
                    "The source-proposal catalogue is unavailable or has not passed validation.",
                },
              },
        );
      }
      const proposalPath = path.match(/^\/api\/proposals\/((?:OPP|PRB)-\d{5})$/);
      if (method === "GET" && proposalPath) {
        if (!proposals.available)
          fail(
            503,
            "catalogue_unavailable",
            "The source-proposal catalogue is unavailable or has not passed validation.",
          );
        const result = proposals.detail(proposalPath[1]);
        if (!result) fail(404, "proposal_missing", "Source proposal not found.");
        return ctx.send(200, management.decorate(proposalPages.decorate(result)));
      }
      if (method === "GET" && path === "/api/management/status")
        return ctx.send(200, management.status());
      const managementBatchPath = path.match(
        /^\/api\/management\/batches\/([a-f0-9]{64})$/,
      );
      if (method === "GET" && managementBatchPath) {
        const receipt = management.batchReceipt(managementBatchPath[1]);
        if (!receipt)
          fail(
            404,
            "management_batch_pending",
            "This batch has not been ingested.",
          );
        return ctx.send(200, receipt);
      }
      const managementPath = path.match(MANAGEMENT_PATH);
      if (method === "GET" && managementPath && !managementPath[2]) {
        const result = await currentManagedProject(managementPath[1]);
        if (!result)
          fail(404, "management_project_missing", "Managed project not found.");
        return ctx.send(200, result);
      }
      if (method === "GET" && path === "/api/management/initial-tasks/summary") {
        only(ctx.query(), []); only(body, []);
        return ctx.send(200, initialProjectTasks.summary());
      }
      if (method === "GET" && path === "/api/management/initial-tasks") {
        const q=ctx.query(); only(q,["page","pageSize"]); only(body,[]);
        for(const [key,value] of Object.entries(q)) if(!/^[1-9][0-9]{0,4}$/.test(value)) fail(400,"invalid_initial_task_page","Invalid initial task page.");
        let result;try{result=initialProjectTasks.list({...(q.page?{page:Number(q.page)}:{}),...(q.pageSize?{pageSize:Number(q.pageSize)}:{})});}catch{fail(400,"invalid_initial_task_page","Invalid initial task page.");}
        return ctx.send(200,result);
      }
    },
    isPrivate(ctx) {
      const { method, path } = ctx;
      return Boolean(
        managementWrite(ctx) ||
        (method === "GET" && OPERATIONS_PATH.test(path)) ||
        (method === "GET" && path === "/api/operations/organizations") ||
        (method === "GET" && path === "/api/meetings"),
      );
    },
    async private(ctx) {
      const { method, path, url, body, user } = ctx;
      if (path === "/api/operations/organizations") {
        // Private fleet projection: operator allowlist first, then the validated source.
        only(body, []);
        try {
          organizationsStatus.authorize(user);
          return ctx.send(200, await organizationsStatus.page(url.searchParams));
        } catch (error) {
          if (error instanceof OrganizationsStatusError) fail(error.status, error.code, error.message);
          throw error;
        }
      }
      const managementPath = path.match(MANAGEMENT_PATH);
      if (managementWrite(ctx, managementPath)) {
        only(ctx.query(), []);
        if (!store.hasAccount(user.address))
          fail(403, "account_required", "Create your BAINK account first.");
        const currentRecord = await currentManagedProject(
          managementPath[1],
          user,
        );
        if (!currentRecord)
          fail(404, "management_project_missing", "Managed project not found.");
        if (method === "GET") {
          only(body, []);
          const result = currentRecord;
          if (!result)
            fail(404, "management_project_missing", "Managed project not found.");
          return ctx.send(200, result);
        }
        // Once this one source uses UAIN, keep historical notes readable but do
        // not accept a second local review submission through the older route.
        if (managementPath[2] === "evidence" && options.nativeProjectPilotEnabled === true &&
            options.nativeProjectPilotConfig?.sourceId === managementPath[1])
          fail(409, "native_project_pilot_required", "Use the UAIN project pilot to submit new work. Existing preparation notes are retained.");
        const result =
          managementPath[2] === "evidence"
            ? management.submitEvidence(user, managementPath[1], body)
            : management.chat(user, managementPath[1], body);
        return ctx.send(result.created ? 201 : 200, result);
      }
      const operationsPath = path.match(OPERATIONS_PATH);
      if (operationsPath) {
        // Never pass partial operator configuration to an unapproved caller.
        if (!paperclip.configured)
          return ctx.send(
            200,
            await disconnectedPaperclip.project(operationsPath[1], ctx.query()),
          );
        if (!operationsViewers.get(operationsPath[1])?.has(user.address))
          fail(
            403,
            "project_operations_forbidden",
            "You do not have permission to view these project operations.",
          );
        const nativeLead = operationsNativeLeads.get(operationsPath[1]);
        if (nativeLead) {
          const access = await nativeProjectAccess.check({
            projectId: operationsPath[1],
            expectedInstanceId: nativeLead.instanceId,
            expectedMember: nativeLead.memberAddress,
            actor: user,
          });
          if (!access.allowed)
            fail(
              access.reason === "proof-unavailable" ? 503 : 403,
              access.reason === "proof-unavailable"
                ? "project_operations_unavailable"
                : "project_operations_forbidden",
              "These project operations are unavailable for this identity.",
            );
        }
        return ctx.send(
          200,
          await paperclip.project(operationsPath[1], ctx.query()),
        );
      }
    },
    async member(ctx) {
      const { method, path, url, user } = ctx;
      if (method === "GET" && path === "/api/meetings") {
        if (smartmeet.configured && !smartmeetMembers.has(user.address))
          fail(
            403,
            "integration_not_authorized",
            "SmartMeet access has not been granted to this identity.",
          );
        const status = url.searchParams.get("status") ?? "all";
        const limit = Number(url.searchParams.get("limit") ?? 20),
          offset = Number(url.searchParams.get("offset") ?? 0);
        if (
          !["all", "upcoming", "started", "ended"].includes(status) ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          !Number.isInteger(offset) ||
          offset < 0 ||
          offset > 100_000
        )
          fail(400, "invalid_query", "Invalid meeting-list filters.");
        try {
          return ctx.send(
            200,
            await smartmeet.listMeetings({ status, limit, offset }),
          );
        } catch {
          fail(
            503,
            "smartmeet_unavailable",
            "SmartMeet meetings are temporarily unavailable.",
          );
        }
      }
    },
  };
}
