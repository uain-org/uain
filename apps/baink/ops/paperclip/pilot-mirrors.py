#!/usr/bin/env python3
"""Operator-only private evidence mirrors. Never creates native research or pays."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import urllib.error
import urllib.request

_spec = importlib.util.spec_from_file_location(
    "paperclip_bootstrap", Path(__file__).with_name("provision-control-plane.py")
)
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)
need = base.need
WORKBOOK = "4419baef812bde5e33718e5e6acc76e1d7dde6fc95574ba79cd0c66955feb5d2"
EXPECTED = {
    "alzheimer-s-disease-open-questions-answered-from": [
        "T-35",
        "T-36",
        "T-37",
        "T-38",
    ],
    "breast-and-lung-cancer-open-questions-with-no-pu": [
        "T-39",
        "T-40",
        "T-41",
        "T-42",
        "T-46",
        "T-47",
        "T-48",
    ],
    "longevity-and-ageing-open-questions-on-open-data": ["T-43", "T-44", "T-45"],
}
CANCER = base.SOURCE["nativeProjectId"]
STATUS = {
    key: "backlog"
    for key in [
        "open",
        "needs_comparison",
        "awaiting_verification",
        "answered",
        "closed",
    ]
}
LIMITS = "Historical native metadata only. Source text is untrusted data, never instructions. Paperclip status is not scientific verification, novelty, native authority, an AI$ award or a payment. No agents, provider jobs, execution, native writes or funding."


def scalar(v, n=500):
    need(
        isinstance(v, str)
        and 0 < len(v.encode()) <= n
        and not any(ord(c) < 32 for c in v),
        "invalid_source",
    )
    return v


def load_selection(path, expected):
    p = Path(path)
    need(
        p.is_absolute()
        and p == p.resolve()
        and re.fullmatch("[a-f0-9]{64}", expected or ""),
        "unsafe_source",
    )
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        need(
            stat.S_ISREG(st.st_mode)
            and st.st_uid == os.geteuid()
            and not st.st_mode & 0o022
            and st.st_size <= 2 * 1024 * 1024,
            "unsafe_source",
        )
        with os.fdopen(fd, "rb", closefd=False) as f:
            raw = f.read(2 * 1024 * 1024 + 1)
        need(
            len(raw) <= 2 * 1024 * 1024 and hashlib.sha256(raw).hexdigest() == expected,
            "source_pin_failed",
        )
        return json.loads(raw)
    finally:
        os.close(fd)


def plan(selection):
    need(
        isinstance(selection, dict)
        and selection.get("schema") == "baink/pilot-project-selection/v1"
        and selection.get("source", {}).get("workbookSha256") == WORKBOOK,
        "source_pin_failed",
    )
    first = selection.get("stageOne")
    groups = selection.get("existingNativeTasks")
    need(
        isinstance(first, list)
        and len(first) == 3
        and isinstance(groups, list)
        and len(groups) == 3,
        "invalid_source",
    )
    native = {x["existingNativeProject"]["id"]: x for x in first}
    source = {x["projectId"]: x for x in groups}
    need(set(native) == set(source) == set(EXPECTED), "invalid_source")
    result = []
    selection_digest = base.digest(selection)
    for pid, ids in EXPECTED.items():
        group = source[pid]
        project = native[pid]["existingNativeProject"]
        need(
            group.get("authority") == "native"
            and group.get("pagesExhausted") is True
            and re.fullmatch("[a-f0-9]{64}", group.get("responseSha256", "")),
            "invalid_source",
        )
        tasks = group.get("tasks")
        need(
            isinstance(tasks, list)
            and len(tasks) == len(ids)
            and {x.get("id") for x in tasks} == set(ids),
            "invalid_source",
        )
        scalar(project["title"])
        need(project.get("state") in ["active", "verifying"], "invalid_source")
        descriptor = {
            "schema": "baink-paperclip/stage-one-mirror/v1",
            "nativeProjectId": pid,
            "selectionDigest": selection_digest,
            "taskSourceSha256": group["responseSha256"],
            "nativeState": project["state"],
            "limitations": LIMITS,
        }
        body = {
            "name": "UAIN "
            + (
                "Alzheimer"
                if pid.startswith("alzheimer")
                else "longevity"
                if pid.startswith("longevity")
                else "cancer"
            )
            + " research - evidence mirror",
            "description": base.canonical(descriptor),
            "status": "backlog",
            "visibility": "private",
            "leadAgentId": None,
            "idempotencyKey": "baink-pilot-mirror-v1:" + pid,
        }
        entries = []
        for task in tasks:
            need(
                task.get("status") in STATUS
                and type(task.get("submissionCount")) is int
                and 0 <= task["submissionCount"] <= 20,
                "invalid_source",
            )
            price = task.get("sourceKarmaPrice")
            need(
                price is None or type(price) is int and 0 <= price <= 1000000,
                "invalid_source",
            )
            scalar(task.get("title"))
            need(
                task.get("url") == "https://uain.global/api/tasks/" + task["id"],
                "invalid_source",
            )
            info = {
                "schema": "baink-paperclip/native-task-evidence/v1",
                "nativeProjectId": pid,
                "nativeTaskId": task["id"],
                "nativeStatus": task["status"],
                "nativeSourceSha256": group["responseSha256"],
                "selectionDigest": selection_digest,
                "submissionCount": task["submissionCount"],
                "sourceKarmaPrice": price,
                "priceMeaning": "Karma/reputation only, not AI$",
                "aiDollarPayment": None,
                "scientificVerification": None,
                "executionEnabled": False,
                "limitations": LIMITS,
            }
            payload = {
                "title": "Native " + task["id"] + ": " + task["title"],
                "description": base.canonical(info),
                "status": STATUS[task["status"]],
                "priority": "low",
                "visibility": "open",
                "parentId": None,
                "assigneeAgentId": None,
                "assigneeUserId": None,
                "executionPolicy": None,
                "watchdog": None,
                "idempotencyKey": "baink-pilot-native-task-v1:"
                + pid
                + ":"
                + task["id"],
            }
            entries.append(
                {"nativeTaskId": task["id"], "source": info, "payload": payload}
            )
        result.append(
            {
                "nativeProjectId": pid,
                "preserveExisting": pid == CANCER,
                "payload": body,
                "tasks": entries,
            }
        )
    return {
        "schema": "baink-paperclip/pilot-mirrors-plan/v1",
        "selectionDigest": selection_digest,
        "sourceRevision": base.REVISION,
        "projects": result,
        "nativeWrites": False,
        "stageTwo": "deferred",
        "scientificVerification": False,
        "payments": None,
    }


class MirrorTransport(base.Transport):
    """Reuse retained cookie custody; add only one fixed-company issue POST."""

    def __init__(self, custody, cid):
        super().__init__(custody)
        self.cid = cid

    def request(
        self, method, path, body=None, actor="anonymous", bearer=None, headers=None
    ):
        route_ok = (
            method == "GET"
            and (
                path
                in [
                    "/api/health",
                    "/api/cli-auth/me",
                    "/api/companies",
                    "/api/companies/" + self.cid,
                ]
                or re.fullmatch(
                    "/api/companies/"
                    + self.cid
                    + r"/(?:agents|routines|projects|issues)",
                    path,
                )
                or re.fullmatch(
                    r"/api/projects/" + base.ID_PATH + r"(?:/access-members)?", path
                )
            )
        ) or (
            method == "POST"
            and (
                path == "/api/auth/sign-in/email"
                or path
                in [
                    f"/api/companies/{self.cid}/projects",
                    f"/api/companies/{self.cid}/issues",
                ]
                or re.fullmatch(
                    r"/api/projects/" + base.ID_PATH + r"/access-members", path
                )
            )
        )
        need(route_ok, "endpoint_forbidden")
        if method != "POST" or path != f"/api/companies/{self.cid}/issues":
            return super().request(method, path, body, actor, bearer, headers)
        need(
            actor == "owner" and bearer is None and headers is None,
            "endpoint_forbidden",
        )
        need(
            isinstance(body, dict)
            and set(body)
            == {
                "projectId",
                "title",
                "description",
                "status",
                "priority",
                "visibility",
                "parentId",
                "assigneeAgentId",
                "assigneeUserId",
                "executionPolicy",
                "watchdog",
                "idempotencyKey",
            }
            and base.UUID.fullmatch(body.get("projectId", ""))
            and body["assigneeAgentId"] is None
            and body["assigneeUserId"] is None
            and body["parentId"] is None
            and body["executionPolicy"] is None
            and body["watchdog"] is None
            and body["visibility"] == "open"
            and body["status"] in set(STATUS.values()),
            "endpoint_forbidden",
        )
        raw = base.canonical(body).encode()
        need(len(raw) <= 16384, "request_limit")
        req = urllib.request.Request(
            base.ORIGIN + path,
            data=raw,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Origin": base.ORIGIN,
                "User-Agent": "BAINK private evidence mirror operator",
            },
        )
        try:
            response = self.clients["owner"].open(req, timeout=20)
        except urllib.error.HTTPError as e:
            response = e
        with response:
            need(response.status < 300 or response.status >= 400, "redirect_forbidden")
            raw = response.read(1048577)
            need(
                len(raw) <= 1048576
                and "application/json"
                in response.headers.get("Content-Type", "").lower(),
                "invalid_response",
            )
            status = response.status
            data = json.loads(raw)
        # Reuse the original atomic cookie persistence path. A lost read remains an
        # uncertain mutation and is reconciled by exact company/project/source intent.
        super().request("GET", "/api/health", actor="owner")
        return status, data


class MirrorController:
    def __init__(self, bootstrap, desired):
        self.boot = bootstrap
        self.custody = bootstrap.custody
        self.http = bootstrap.http
        self.p = json.loads(base.canonical(desired))
        need(
            bootstrap.s.get("companyComplete") is True
            and base.UUID.fullmatch(bootstrap.s.get("companyId", ""))
            and base.UUID.fullmatch(bootstrap.s.get("projectId", "")),
            "bootstrap_required",
        )
        self.cid = bootstrap.s["companyId"]
        self.name = "pilot-mirrors.json"
        binding = {
            "schema": "baink-paperclip/pilot-mirrors-journal/v1",
            "sourceRevision": base.REVISION,
            "bootstrapId": bootstrap.s["bootstrapId"],
            "companyId": self.cid,
            "ownerId": bootstrap.s["ownerId"],
            "viewerId": bootstrap.s["viewerId"],
            "planDigest": base.digest(desired),
        }
        if (self.custody.path / self.name).exists():
            self.j = self.custody.read(self.name)
            need(
                all(self.j.get(k) == v for k, v in binding.items()),
                "mirror_journal_conflict",
            )
        else:
            self.j = {**binding, "operations": {}, "projects": {}, "issues": {}}
            self.save()

    def save(self):
        self.custody.write(self.name, self.j)

    def get(self, path, viewer=False):
        code, data = self.http.request(
            "GET",
            path,
            actor="anonymous" if viewer else "owner",
            bearer=self.boot.s["viewerBoardToken"] if viewer else None,
        )
        need(code == 200, "mirror_read_failed")
        return data

    def guard(self):
        health = self.get("/api/health")
        need(
            health.get("commit") == base.REVISION
            and health.get("status") == "ok"
            and health.get("deploymentMode") == "authenticated"
            and health.get("deploymentExposure") == "private",
            "runtime_binding_failed",
        )
        need(
            self.boot.session("owner").get("isInstanceAdmin") is True, "owner_required"
        )
        need(
            self.get("/api/companies/" + self.cid + "/agents") == []
            and self.get("/api/companies/" + self.cid + "/routines") == [],
            "execution_not_zero",
        )
        company = self.get("/api/companies/" + self.cid)
        need(
            company.get("id") == self.cid and company.get("budgetMonthlyCents") == 0,
            "company_binding_failed",
        )
        need(
            [x.get("id") for x in self.get("/api/companies")] == [self.cid],
            "company_binding_failed",
        )
        cancer = self.get("/api/projects/" + self.boot.s["projectId"])
        self.row_matches(
            cancer,
            {
                "name": "UAIN cancer research — evidence mirror",
                "description": base.canonical(base.SOURCE),
                "status": "backlog",
                "visibility": "private",
                "leadAgentId": None,
            },
            "project",
        )
        issues = self.get("/api/companies/" + self.cid + "/issues")
        need(
            isinstance(issues, list)
            and len(issues) <= 14
            and company.get("issueCounter") == len(issues),
            "issue_inventory_unqualified",
        )
        expected = {
            t["payload"]["description"]: (p, t)
            for p in self.p["projects"]
            for t in p["tasks"]
        }
        seen_issues = set()
        for row in issues:
            need(row.get("description") in expected, "unowned_issue")
            project, task = expected[row["description"]]
            pid = self.j["projects"].get(
                project["nativeProjectId"],
                self.boot.s["projectId"] if project["preserveExisting"] else None,
            )
            need(pid is not None, "mirror_project_mapping_failed")
            native = task["nativeTaskId"]
            need(native not in seen_issues, "mirror_duplicate")
            seen_issues.add(native)
            body = {**task["payload"], "projectId": pid}
            self.check_owned(
                "issue:" + native, "/api/companies/" + self.cid + "/issues", body, row
            )
            need(
                self.j["issues"].get(native, row["id"]) == row["id"],
                "mirror_returned_id_changed",
            )
            self.row_matches(row, body, "issue")
        projects = self.get("/api/companies/" + self.cid + "/projects")
        need(
            isinstance(projects, list) and 1 <= len(projects) <= 3,
            "project_inventory_failed",
        )
        seen_projects = set()
        for row in projects:
            if row.get("id") == self.boot.s["projectId"]:
                wanted = {
                    "name": "UAIN cancer research — evidence mirror",
                    "description": base.canonical(base.SOURCE),
                    "status": "backlog",
                    "visibility": "private",
                    "leadAgentId": None,
                }
            else:
                matches = [
                    p
                    for p in self.p["projects"]
                    if not p["preserveExisting"]
                    and p["payload"]["description"] == row.get("description")
                ]
                need(len(matches) == 1, "unowned_project")
                wanted = matches[0]["payload"]
                native = matches[0]["nativeProjectId"]
                need(native not in seen_projects, "mirror_duplicate")
                seen_projects.add(native)
                self.check_owned(
                    "project:" + native,
                    "/api/companies/" + self.cid + "/projects",
                    wanted,
                    row,
                )
                need(
                    self.j["projects"].get(native, row["id"]) == row["id"],
                    "mirror_returned_id_changed",
                )
            self.row_matches(row, wanted, "project")
            acl = self.get("/api/projects/" + row["id"] + "/access-members")
            need(
                isinstance(acl, list)
                and len(acl) <= 2
                and all(
                    a.get("subjectType") == "user"
                    and a.get("subjectId")
                    in {self.boot.s["ownerId"], self.boot.s["viewerId"]}
                    for a in acl
                ),
                "acl_scope_failed",
            )
            pairs = [(a.get("subjectType"), a.get("subjectId")) for a in acl]
            need(len(pairs) == len(set(pairs)), "acl_duplicate")
            viewer_rows = [
                a
                for a in acl
                if a.get("subjectType") == "user"
                and a.get("subjectId") == self.boot.s["viewerId"]
            ]
            if row["id"] == self.boot.s["projectId"]:
                self.check_original_acl(acl)
                view = self.get("/api/projects/" + row["id"], True)
                self.row_matches(view, wanted, "project")
                need(view.get("id") == row["id"], "viewer_read_failed")
            else:
                op = self.j["operations"].get("acl:" + row["id"])
                if op and op.get("state") in [
                    "returned",
                    "send_started",
                    "response_uncertain",
                ]:
                    need(
                        len(viewer_rows) == 1,
                        "acl_returned_resource_missing"
                        if op["state"] == "returned"
                        else "acl_response_uncertain",
                    )
                if viewer_rows:
                    self.check_acl_owned(row["id"], viewer_rows[0])
                    view = self.get("/api/projects/" + row["id"], True)
                    self.row_matches(view, wanted, "project")
                    need(view.get("id") == row["id"], "viewer_read_failed")
        issue_ids = {row["id"] for row in issues}
        project_ids = {row["id"] for row in projects}
        need(
            len(issue_ids) == len(issues) and len(project_ids) == len(projects),
            "mirror_duplicate",
        )
        for key, op in self.j["operations"].items():
            if op.get("state") == "returned" and (
                key.startswith("issue:") or key.startswith("project:")
            ):
                need(
                    op.get("id")
                    in (issue_ids if key.startswith("issue:") else project_ids),
                    "mirror_returned_resource_missing",
                )
        need(
            set(self.j["issues"].values()) <= issue_ids
            and set(self.j["projects"].values()) <= project_ids,
            "mirror_returned_resource_missing",
        )
        self.boot.validate_viewer(self.get("/api/cli-auth/me", True), True)

    def check_owned(self, key, path, body, row):
        op = self.j["operations"].get(key)
        intent = {"method": "POST", "path": path, "body": body, "actor": "owner"}
        need(
            op is not None
            and op.get("intent") == intent
            and op.get("intentDigest") == base.digest(intent),
            "mirror_unowned_match",
        )
        need(
            op.get("state") in ["send_started", "response_uncertain", "returned"],
            "mirror_unowned_match",
        )
        if op.get("state") == "returned":
            need(base.UUID.fullmatch(op.get("id", "")), "mirror_returned_id_missing")
        need(
            op.get("id") is None or op["id"] == row.get("id"),
            "mirror_returned_id_changed",
        )

    def acl_row(self, pid, row):
        need(
            isinstance(row, dict)
            and base.UUID.fullmatch(row.get("id", ""))
            and row.get("companyId") == self.cid
            and row.get("projectId") == pid
            and row.get("subjectType") == "user"
            and row.get("subjectId") == self.boot.s["viewerId"],
            "acl_scope_failed",
        )
        return row

    def check_original_acl(self, rows):
        pid = self.boot.s["projectId"]
        receipt = self.boot.s.get("operations", {}).get("viewer-project-acl", {})
        need(
            receipt.get("state") == "returned" and receipt.get("status") == 201,
            "bootstrap_acl_receipt_required",
        )
        expected = self.acl_row(pid, receipt.get("response"))
        matches = [
            row
            for row in rows
            if row.get("subjectType") == "user"
            and row.get("subjectId") == self.boot.s["viewerId"]
        ]
        need(len(matches) == 1, "original_viewer_acl_missing")
        self.acl_row(pid, matches[0])
        need(matches[0]["id"] == expected["id"], "acl_returned_id_changed")

    def check_acl_owned(self, pid, row):
        self.acl_row(pid, row)
        op = self.j["operations"].get("acl:" + pid)
        body = {"subjectType": "user", "subjectId": self.boot.s["viewerId"]}
        need(
            op is not None
            and op.get("intent")
            == {
                "method": "POST",
                "path": "/api/projects/" + pid + "/access-members",
                "body": body,
            }
            and op.get("intentDigest") == base.digest(body),
            "acl_unowned_match",
        )
        need(
            op.get("state") in ["send_started", "response_uncertain", "returned"],
            "acl_unowned_match",
        )
        if op.get("state") == "returned":
            need(base.UUID.fullmatch(op.get("id", "")), "acl_returned_id_missing")
        need(op.get("id") is None or op["id"] == row["id"], "acl_returned_id_changed")

    def row_matches(self, row, body, kind):
        need(
            isinstance(row, dict)
            and base.UUID.fullmatch(row.get("id", ""))
            and row.get("companyId") == self.cid,
            "mirror_scope_failed",
        )
        need(
            all(
                # Pinned issues service10575-10602 forces private-project issues
                # private. Keep the original open request and immutable intent;
                # validate only that exact persisted result, never either value.
                row.get(k)
                == ("private" if kind == "issue" and k == "visibility" else v)
                for k, v in body.items()
                if k not in ["idempotencyKey", "watchdog"]
            ),
            "mirror_source_drift",
        )
        if kind == "issue":
            need(
                row.get("createdByUserId") == self.boot.s["ownerId"],
                "mirror_actor_failed",
            )
            need(
                row.get("watchdog") is None
                and row.get("executionPolicy") in [None, {}]
                and row.get("executionWorkspaceId") is None
                and row.get("projectWorkspaceId") is None
                and row.get("executionWorkspaceSettings") in [None, {}],
                "issue_execution_configured",
            )
        else:
            need(
                row.get("leadAgentId") is None and row.get("workspaces", []) == [],
                "project_execution_configured",
            )
            if body.get("description") != base.canonical(base.SOURCE):
                need(
                    row.get("privacyOwnerUserId") == self.boot.s["ownerId"],
                    "mirror_actor_failed",
                )
        return row

    def mutate(self, key, path, body, kind):
        intent = {"method": "POST", "path": path, "body": body, "actor": "owner"}
        digest = base.digest(intent)
        op = self.j["operations"].get(key)
        rows = self.get(path)
        need(isinstance(rows, list) and len(rows) <= 100, "mirror_inventory_failed")
        matches = [
            x
            for x in rows
            if x.get("description") == body.get("description")
            and x.get("companyId") == self.cid
            and (kind != "issue" or x.get("projectId") == body.get("projectId"))
        ]
        need(len(matches) <= 1, "mirror_duplicate")
        if op:
            need(op["intentDigest"] == digest, "mirror_intent_conflict")
            if matches:
                row = self.row_matches(matches[0], body, kind)
                self.check_owned(key, path, body, row)
                op.update(state="returned", id=row["id"], reconciled=True)
                self.save()
                return row
            need(op["state"] == "prepared", "mirror_response_uncertain")
        else:
            need(not matches, "mirror_unowned_match")
            need(len(self.j["operations"]) < 40, "journal_limit")
            op = {"intent": intent, "intentDigest": digest, "state": "prepared"}
            self.j["operations"][key] = op
            self.save()
        op.update(state="send_started", sentAt=time.time())
        self.save()
        try:
            code, row = self.http.request("POST", path, body, actor="owner")
        except Exception:
            op["state"] = "response_uncertain"
            self.save()
            raise base.Stop("mirror_response_uncertain") from None
        need(code in [200, 201], "mirror_create_failed")
        self.row_matches(row, body, kind)
        op.update(state="returned", id=row["id"])
        self.save()
        return row

    def acl(self, pid):
        path = "/api/projects/" + pid + "/access-members"
        body = {"subjectType": "user", "subjectId": self.boot.s["viewerId"]}
        rows = self.get(path)
        need(isinstance(rows, list) and len(rows) <= 2, "acl_inventory_failed")
        if pid == self.boot.s["projectId"]:
            self.check_original_acl(rows)
            return
        matches = [x for x in rows if all(x.get(k) == v for k, v in body.items())]
        need(len(matches) <= 1, "acl_duplicate")
        key = "acl:" + pid
        if matches:
            self.check_acl_owned(pid, matches[0])
            op = self.j["operations"][key]
            op.update(state="returned", id=matches[0]["id"], reconciled=True)
            self.save()
        else:
            prior = self.j["operations"].get(key)
            intent = {"method": "POST", "path": path, "body": body}
            need(
                prior is None
                or (
                    prior.get("state") == "prepared"
                    and prior.get("intent") == intent
                    and prior.get("intentDigest") == base.digest(body)
                ),
                "acl_response_uncertain",
            )
            op = prior or {
                "intent": intent,
                "intentDigest": base.digest(body),
                "state": "prepared",
            }
            self.j["operations"][key] = op
            self.save()
            op["state"] = "send_started"
            self.save()
            try:
                code, row = self.http.request("POST", path, body, actor="owner")
            except Exception:
                op["state"] = "response_uncertain"
                self.save()
                raise base.Stop("acl_response_uncertain") from None
            need(code == 201, "acl_failed")
            self.acl_row(pid, row)
            op.update(state="returned", id=row["id"])
            self.save()
        current = [
            x for x in self.get(path) if all(x.get(k) == v for k, v in body.items())
        ]
        need(len(current) == 1, "acl_failed")
        self.check_acl_owned(pid, current[0])

    def apply(self):
        self.j["complete"] = False
        self.save()
        self.guard()
        for item in self.p["projects"]:
            native = item["nativeProjectId"]
            if item["preserveExisting"]:
                pid = self.boot.s["projectId"]
                row = self.get("/api/projects/" + pid)
                body = {
                    "name": "UAIN cancer research — evidence mirror",
                    "description": base.canonical(base.SOURCE),
                    "status": "backlog",
                    "visibility": "private",
                    "leadAgentId": None,
                }
                self.row_matches(row, body, "project")
            else:
                row = self.mutate(
                    "project:" + native,
                    "/api/companies/" + self.cid + "/projects",
                    item["payload"],
                    "project",
                )
                pid = row["id"]
            self.j["projects"][native] = pid
            self.save()
            self.acl(pid)
            read = self.get("/api/projects/" + pid, True)
            need(
                read.get("id") == pid
                and read.get("companyId") == self.cid
                and read.get("visibility") == "private",
                "viewer_read_failed",
            )
            for task in item["tasks"]:
                self.guard()
                body = {**task["payload"], "projectId": pid}
                row = self.mutate(
                    "issue:" + task["nativeTaskId"],
                    "/api/companies/" + self.cid + "/issues",
                    body,
                    "issue",
                )
                self.j["issues"][task["nativeTaskId"]] = row["id"]
                self.save()
        self.guard()
        need(
            len(self.get("/api/companies/" + self.cid + "/projects")) == 3,
            "project_inventory_failed",
        )
        visible = self.get("/api/companies/" + self.cid + "/issues", True)
        need(
            {x["id"] for x in visible} == set(self.j["issues"].values()),
            "viewer_issue_scope_failed",
        )
        self.j["complete"] = True
        self.save()
        return {
            "status": "passed",
            "scope": "private-historical-evidence-mirrors",
            "projects": 3,
            "issues": 14,
            "agents": 0,
            "nativeWrites": 0,
            "payments": None,
            "stageTwo": "deferred",
            "scientificVerification": False,
        }


def main():
    store = None
    try:
        need(
            len(sys.argv) in [4, 5] and sys.argv[1] in ["plan", "apply"],
            "invalid_operator_request",
        )
        if sys.argv[1] == "plan":
            need(len(sys.argv) == 4, "invalid_operator_request")
            desired = plan(load_selection(sys.argv[2], sys.argv[3]))
            print(base.canonical(desired))
            return
        need(len(sys.argv) == 5 and os.geteuid() == 0, "root_operator_required")
        need(Path(sys.argv[2]).is_dir(), "bootstrap_required")
        store = base.Custody(sys.argv[2])
        desired = plan(load_selection(sys.argv[3], sys.argv[4]))
        transport = base.Transport(store)
        bootstrap = base.Controller(store, transport)
        need(bootstrap.s.get("companyComplete") is True, "bootstrap_required")
        bootstrap.http = MirrorTransport(store, bootstrap.s["companyId"])
        print(base.canonical(MirrorController(bootstrap, desired).apply()))
    except Exception as e:
        print(
            base.canonical(
                {
                    "status": "stopped",
                    "code": str(e)
                    if isinstance(e, base.Stop)
                    else "mirror_operation_failed",
                    "noAutomaticRetry": True,
                }
            )
        )
        sys.exit(1)
    finally:
        if store:
            store.close()


if __name__ == "__main__":
    main()
