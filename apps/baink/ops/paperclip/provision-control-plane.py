#!/usr/bin/env python3
"""Operator-only, two-phase private bootstrap. No deployment or SSH operations.
Run identities, close signup/restart/reinspect externally, then run company.
All returned identifiers/credentials remain in root-private state.json.
"""

import fcntl
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ORIGIN = "http://127.0.0.1:3101"
REVISION = "dce383c733bb1ca31cd34d7dbb82bda597ad7418"
UUID = re.compile(
    r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
)
USER = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
SOURCE = {
    "schema": "baink-paperclip/existing-native-evidence/v1",
    "nativeProjectId": "breast-and-lung-cancer-open-questions-with-no-pu",
    "scope": "private evidence mirror of an existing native project",
    "references": [
        "docs/baink/native-project-qualification.md",
        "output/baink/native-paperclip-pilot-qualification-20261031/",
    ],
    "limitations": "Historical source evidence only; not holder consent, native delegation, current novelty approval, execution, a new research problem or an AI$ payment. No agents, tasks, providers or native writes.",
}
# Closed transport policy: adding a controller call cannot silently add an
# execution/provider/native endpoint. Values below are generated internally.
ID_PATH = r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
ROUTES = {
    "GET": [
        r"/api/health",
        r"/api/cli-auth/me",
        r"/api/companies",
        rf"/api/companies/{ID_PATH}(?:/(?:members|agents|routines|issues|projects))?",
        rf"/api/projects/{ID_PATH}(?:/access-members)?",
    ],
    "POST": [
        r"/api/auth/(?:sign-up|sign-in)/email",
        r"/api/bootstrap/claim",
        r"/api/companies",
        rf"/api/companies/{ID_PATH}/(?:invites|projects)",
        r"/api/invites/pcp_invite_[A-Za-z0-9_-]{16,256}/accept",
        rf"/api/projects/{ID_PATH}/access-members",
        r"/api/cli-auth/challenges",
        rf"/api/cli-auth/challenges/{ID_PATH}/approve",
    ],
    "PATCH": [rf"/api/projects/{ID_PATH}"],
}


class Stop(Exception):
    pass


def need(ok, code="qualification_failed"):
    if not ok:
        raise Stop(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class Custody:
    def __init__(self, directory):
        self.path = Path(directory)
        need(
            self.path.is_absolute() and self.path == self.path.resolve(),
            "unsafe_custody",
        )
        self.path.mkdir(mode=0o700, parents=False, exist_ok=True)
        st = self.path.lstat()
        need(
            stat.S_ISDIR(st.st_mode)
            and st.st_uid == os.geteuid()
            and stat.S_IMODE(st.st_mode) == 0o700,
            "unsafe_custody",
        )
        self.lock = os.open(
            self.path / "controller.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
        )
        self.checked_fd(self.lock)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Stop("controller_busy") from None

    def checked_fd(self, fd):
        st = os.fstat(fd)
        need(
            stat.S_ISREG(st.st_mode)
            and st.st_uid == os.geteuid()
            and st.st_nlink == 1
            and stat.S_IMODE(st.st_mode) == 0o600,
            "unsafe_custody_file",
        )

    def read(self, name):
        fd = os.open(self.path / name, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            self.checked_fd(fd)
            with os.fdopen(fd, "r", closefd=False) as stream:
                raw = stream.read(2 * 1024 * 1024 + 1)
            need(len(raw.encode()) <= 2 * 1024 * 1024, "custody_limit")
            return json.loads(raw)
        finally:
            os.close(fd)

    def write(self, name, data):
        raw = (canonical(data) + "\n").encode()
        need(len(raw) <= 2 * 1024 * 1024, "custody_limit")
        temp = self.path / ("." + secrets.token_hex(16))
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(fd)
            os.replace(temp, self.path / name)
            self.sync()
        finally:
            os.close(fd)
            temp.unlink(missing_ok=True)

    def sync(self):
        fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def close(self):
        os.close(self.lock)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class Transport:
    def __init__(self, custody):
        self.custody = custody
        self.jars = {}
        self.clients = {}
        for actor in ("owner", "viewer", "anonymous"):
            filename = custody.path / (actor + "-cookies.txt")
            jar = http.cookiejar.LWPCookieJar(str(filename))
            if filename.exists():
                fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    custody.checked_fd(fd)
                    need(os.fstat(fd).st_size <= 1048576, "cookie_limit")
                finally:
                    os.close(fd)
                jar.load(ignore_discard=True, ignore_expires=True)
            self.jars[actor] = jar
            self.clients[actor] = urllib.request.build_opener(
                urllib.request.ProxyHandler({}),
                urllib.request.HTTPCookieProcessor(jar),
                NoRedirect(),
            )

    def request(
        self, method, path, body=None, actor="anonymous", bearer=None, headers=None
    ):
        need(
            actor in self.clients and method in ("GET", "POST", "PATCH"),
            "invalid_request",
        )
        u = urllib.parse.urlsplit(path)
        need(
            isinstance(path, str)
            and len(path) <= 2048
            and path.startswith("/api/")
            and not u.scheme
            and not u.netloc
            and not u.fragment
            and ".." not in u.path
            and "\\" not in path
            and not any(ord(c) < 32 for c in path),
            "invalid_request",
        )
        need(
            not u.query
            and any(re.fullmatch(pattern, path) for pattern in ROUTES[method]),
            "endpoint_forbidden",
        )
        need(
            method != "PATCH"
            or (
                isinstance(body, dict)
                and set(body) == {"name"}
                and isinstance(body["name"], str)
                and len(body["name"]) <= 1000
            ),
            "endpoint_forbidden",
        )
        hs = {
            "Accept": "application/json",
            "Origin": ORIGIN,
            "User-Agent": "BAINK private control-plane bootstrap",
        }
        if body is not None:
            hs["Content-Type"] = "application/json"
        if bearer:
            need(
                re.fullmatch(r"pcp_board_[A-Za-z0-9_-]{16,4000}", bearer), "invalid_key"
            )
            hs["Authorization"] = "Bearer " + bearer
        need(
            not headers or headers == {"X-Paperclip-Receipt-Only": "true"},
            "invalid_request",
        )
        hs.update(headers or {})
        raw = None if body is None else canonical(body).encode()
        need(raw is None or len(raw) <= 16384, "request_limit")
        req = urllib.request.Request(ORIGIN + path, data=raw, headers=hs, method=method)
        try:
            response = self.clients[actor].open(req, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            need(response.status < 300 or response.status >= 400, "redirect_forbidden")
            content = response.read(1048577)
            need(len(content) <= 1048576, "response_limit")
            need(
                not content
                or "application/json"
                in response.headers.get("Content-Type", "").lower(),
                "invalid_response",
            )
            data = json.loads(content) if content else None
            code = response.status
        # Cookie bytes are sensitive; private file is fsynced before journal receipt.
        filename = self.custody.path / (actor + "-cookies.txt")
        temp = self.custody.path / (".cookies-" + secrets.token_hex(16))
        # LWP save uses0600; save to a new private path, then fsync+rename so a
        # killed request never truncates the only retained session jar.
        self.jars[actor].save(str(temp), ignore_discard=True, ignore_expires=True)
        fd = os.open(temp, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            self.custody.checked_fd(fd)
            need(os.fstat(fd).st_size <= 1048576, "cookie_limit")
            os.fsync(fd)
            os.replace(temp, filename)
            self.custody.sync()
        finally:
            os.close(fd)
            temp.unlink(missing_ok=True)
        return code, data


class Controller:
    def __init__(self, custody, transport):
        self.custody, self.http = custody, transport
        if (custody.path / "state.json").exists():
            self.s = custody.read("state.json")
            need(
                self.s.get("schema") == "baink-paperclip/bootstrap/v1"
                and self.s.get("origin") == ORIGIN
                and self.s.get("sourceRevision") == REVISION
                and self.s.get("sourceDigest") == digest(SOURCE),
                "journal_binding_failed",
            )
        else:
            self.s = {
                "schema": "baink-paperclip/bootstrap/v1",
                "origin": ORIGIN,
                "sourceRevision": REVISION,
                "sourceDigest": digest(SOURCE),
                "bootstrapId": str(uuid.uuid4()),
                "operations": {},
                "checks": [],
                "credentials": {},
            }
            for actor in ("owner", "viewer"):
                self.s["credentials"][actor] = {
                    "name": "BAINK " + actor + " (automation)",
                    "email": "baink-"
                    + actor
                    + "-"
                    + secrets.token_hex(16)
                    + "@control-plane.invalid",
                    "password": secrets.token_urlsafe(36),
                }
            self.save()

    def save(self):
        self.custody.write("state.json", self.s)

    def checked(self, label, ok):
        need(ok, label)
        if label not in self.s["checks"]:
            self.s["checks"].append(label)
            self.save()

    def get(self, path, actor="owner", bearer=None):
        code, data = self.http.request("GET", path, actor=actor, bearer=bearer)
        need(code == 200, "read_failed")
        return data

    def mutate(
        self, key, actor, method, path, body, headers=None, retry=False, bearer=None
    ):
        intent = {
            "actor": actor,
            "method": method,
            "path": path,
            "body": body,
            "headers": headers or {},
            "bearerSha256": hashlib.sha256(bearer.encode()).hexdigest()
            if bearer
            else None,
        }
        prior = self.s["operations"].get(key)
        if prior:
            need(prior["intentDigest"] == digest(intent), "intent_conflict")
            if prior["state"] == "returned":
                return prior["status"], prior["response"]
            # Both pinned routes serialize the exact stable intent: project
            # idempotency receipt, or same-user/same-secret challenge approval.
            need(
                retry and key in ("project-create", "viewer-key-approve"),
                "operation_uncertain",
            )
        else:
            need(len(self.s["operations"]) < 128, "journal_limit")
            prior = {
                "intent": intent,
                "intentDigest": digest(intent),
                "state": "prepared",
            }
            self.s["operations"][key] = prior
            self.save()
        prior.update(state="send_started", sentAt=time.time())
        self.save()
        try:
            code, data = self.http.request(
                method, path, body, actor=actor, headers=headers, bearer=bearer
            )
        except Exception:
            prior["state"] = "response_uncertain"
            self.save()
            raise Stop("response_uncertain") from None
        prior.update(state="returned", status=code, response=data)
        self.save()
        return code, data

    def health(self, actor="anonymous"):
        health = self.get("/api/health", actor)
        self.checked(
            "private-pinned-runtime",
            health.get("status") == "ok"
            and health.get("commit") == REVISION
            and health.get("deploymentMode") == "authenticated"
            and health.get("deploymentExposure") == "private",
        )
        # Anonymous authenticated-mode health deliberately omits authReady.
        # Require it only after the retained owner session is authenticated.
        if actor == "owner":
            self.checked("authenticated-runtime-ready", health.get("authReady") is True)
        return health

    def session(self, actor):
        code, me = self.http.request("GET", "/api/cli-auth/me", actor=actor)
        if code == 401:
            body = {k: self.s["credentials"][actor][k] for k in ("email", "password")}
            key = "signin-" + actor + "-" + str(len(self.s["operations"]))
            status, _ = self.mutate(key, actor, "POST", "/api/auth/sign-in/email", body)
            need(status == 200, "signin_failed")
            me = self.get("/api/cli-auth/me", actor)
        else:
            need(code == 200, "session_failed")
        need(
            me.get("source") == "session" and USER.fullmatch(me.get("userId", "")),
            "session_binding_failed",
        )
        expected = self.s.get(actor + "Id")
        need(expected is None or me["userId"] == expected, "session_binding_failed")
        return me

    def identities(self):
        health = self.health()
        need(
            self.s.get("ownerId")
            or health.get("bootstrapStatus") == "bootstrap_pending",
            "not_fresh_instance",
        )
        for actor in ("owner", "viewer"):
            key = "signup-" + actor
            if key not in self.s["operations"]:
                code, _ = self.mutate(
                    key,
                    actor,
                    "POST",
                    "/api/auth/sign-up/email",
                    self.s["credentials"][actor],
                )
                need(code == 200, "signup_failed")
            # An interrupted signup is reconciled by exact stored credential signin,
            # never by generating another account or replacing the original intent.
            me = self.session(actor)
            self.s[actor + "Id"] = me["userId"]
            self.save()
            if actor == "owner":
                if not me["isInstanceAdmin"]:
                    code, data = self.mutate(
                        "claim-admin", actor, "POST", "/api/bootstrap/claim", {}
                    )
                    need(
                        code == 200
                        and data.get("claimed") is True
                        and data.get("userId") == me["userId"],
                        "admin_claim_failed",
                    )
                self.checked(
                    "owner-admin", self.session(actor).get("isInstanceAdmin") is True
                )
                self.health("owner")
            else:
                self.checked(
                    "viewer-initial-isolation",
                    me.get("isInstanceAdmin") is False
                    and me.get("companyIds") == []
                    and me.get("memberships") == []
                    and me["userId"] != self.s["ownerId"],
                )
        self.s["identitiesComplete"] = True
        self.save()
        return {
            "status": "passed",
            "phase": "identities",
            "nextAction": "disable_signup_restart_reinspect_relay",
            "checks": len(self.s["checks"]),
        }

    def disabled_signup(self):
        code, data = self.mutate(
            "signup-disabled-probe-" + str(len(self.s["operations"])),
            "anonymous",
            "POST",
            "/api/auth/sign-up/email",
            self.s["credentials"]["viewer"],
        )
        self.checked(
            "signup-disabled",
            code == 400
            and isinstance(data, dict)
            and data.get("code") == "EMAIL_PASSWORD_SIGN_UP_DISABLED",
        )
        self.s["signupClosed"] = True
        self.save()

    def validate_viewer(self, me, bearer=False):
        cid = self.s["companyId"]
        need(
            me.get("userId") == self.s["viewerId"]
            and me.get("isInstanceAdmin") is False
            and me.get("companyIds") == [cid]
            and me.get("source") == ("board_key" if bearer else "session"),
            "viewer_scope_failed",
        )
        members = me.get("memberships")
        need(
            isinstance(members, list)
            and len(members) == 1
            and members[0].get("companyId") == cid
            and members[0].get("membershipRole") == "viewer"
            and members[0].get("status") == "active",
            "viewer_scope_failed",
        )
        if bearer:
            need(UUID.fullmatch(me.get("keyId", "")), "viewer_key_failed")

    def company(self):
        need(self.s.get("identitiesComplete") is True, "identities_required")
        self.health()
        self.checked(
            "retained-owner-session",
            self.session("owner").get("isInstanceAdmin") is True,
        )
        self.health("owner")
        self.checked(
            "retained-viewer-session",
            self.session("viewer").get("isInstanceAdmin") is False,
        )
        self.disabled_signup()
        body = {
            "name": "BAINK private research evidence",
            "description": "Private zero-agent evidence control plane; bootstrap-intent:"
            + self.s["bootstrapId"]
            + "; no execution, native authority or funding.",
            "budgetMonthlyCents": 0,
            "defaultResponsibleUserId": self.s["ownerId"],
        }
        companies = self.get("/api/companies")
        need(
            isinstance(companies, list) and len(companies) <= 1,
            "company_reconciliation_required",
        )
        if not self.s.get("companyId"):
            op = self.s["operations"].get("company-create")
            if op:
                matches = [
                    c
                    for c in companies
                    if all(c.get(k) == v for k, v in body.items())
                    and UUID.fullmatch(c.get("id", ""))
                ]
                need(len(matches) == 1, "company_reconciliation_required")
                self.s["companyId"] = matches[0]["id"]
                self.save()
            else:
                need(companies == [], "not_fresh_instance")
                code, company = self.mutate(
                    "company-create", "owner", "POST", "/api/companies", body
                )
                need(
                    code == 201 and UUID.fullmatch(company.get("id", "")),
                    "company_create_failed",
                )
                self.s["companyId"] = company["id"]
                self.save()
        cid = self.s["companyId"]
        need(UUID.fullmatch(cid), "company_binding_failed")
        company = self.get("/api/companies/" + cid)
        self.checked(
            "one-bound-company",
            all(company.get(k) == v for k, v in body.items())
            and [c.get("id") for c in self.get("/api/companies")] == [cid],
        )
        self.zero_execution(cid)
        self.ensure_viewer(cid)
        pid = self.ensure_project(cid)
        self.ensure_acl(pid)
        self.ensure_key(cid)
        token = self.s["viewerBoardToken"]
        self.validate_viewer(self.get("/api/cli-auth/me", "anonymous", token), True)
        project = self.get("/api/projects/" + pid, "anonymous", token)
        self.checked(
            "viewer-private-read",
            project.get("id") == pid
            and project.get("companyId") == cid
            and project.get("visibility") == "private"
            and project.get("leadAgentId") is None,
        )
        # No-op metadata write still exercises the real permission boundary.
        code, _ = self.mutate(
            "viewer-write-denial",
            "viewer",
            "PATCH",
            "/api/projects/" + pid,
            {"name": project["name"]},
        )
        self.checked("viewer-write-denied", code == 403)
        code, _ = self.mutate(
            "viewer-bearer-write-denial",
            "anonymous",
            "PATCH",
            "/api/projects/" + pid,
            {"name": project["name"]},
            bearer=token,
        )
        self.checked("viewer-bearer-write-denied", code == 403)
        for path, label in [
            ("/api/companies/" + cid + "/members", "viewer-admin-denied"),
            ("/api/companies/" + cid, "anonymous-company-denied"),
            ("/api/projects/" + pid, "anonymous-project-denied"),
        ]:
            code, _ = self.http.request(
                "GET",
                path,
                actor="anonymous",
                bearer=token if label == "viewer-admin-denied" else None,
            )
            self.checked(label, code in (401, 403, 404))
        self.zero_execution(cid, token)
        self.s["companyComplete"] = True
        self.save()
        return {
            "status": "passed",
            "phase": "company",
            "checks": len(self.s["checks"]),
            "executionEnabled": False,
            "nativeWrites": 0,
        }

    def zero_execution(self, cid, token=None):
        for family in ("agents", "routines", "issues"):
            rows = self.get(
                "/api/companies/" + cid + "/" + family,
                "anonymous" if token else "owner",
                token,
            )
            self.checked(
                ("viewer-" if token else "owner-") + "zero-" + family, rows == []
            )

    def ensure_viewer(self, cid):
        me = self.session("viewer")
        if me.get("companyIds") != [cid]:
            code, invite = self.mutate(
                "viewer-invite",
                "owner",
                "POST",
                "/api/companies/" + cid + "/invites",
                {"allowedJoinTypes": "human", "humanRole": "viewer"},
            )
            need(
                code == 201
                and re.fullmatch(
                    r"pcp_invite_[A-Za-z0-9_-]{16,256}", invite.get("token", "")
                ),
                "invite_failed",
            )
            code, _ = self.mutate(
                "viewer-accept",
                "viewer",
                "POST",
                "/api/invites/" + invite["token"] + "/accept",
                {"requestType": "human"},
            )
            need(code == 202, "invite_accept_failed")
            me = self.session("viewer")
        self.validate_viewer(me)
        members = self.get("/api/companies/" + cid + "/members").get("members", [])
        need(
            len(members) == 2
            and {m.get("principalId") for m in members}
            == {self.s["ownerId"], self.s["viewerId"]},
            "member_inventory_failed",
        )
        owner = next(m for m in members if m["principalId"] == self.s["ownerId"])
        self.checked(
            "owner-membership",
            owner.get("membershipRole") == "owner" and owner.get("status") == "active",
        )
        viewer = next(m for m in members if m["principalId"] == self.s["viewerId"])
        self.checked(
            "viewer-grants-qualified",
            viewer.get("membershipRole") == "viewer"
            and viewer.get("status") == "active"
            and len(viewer.get("grants", [])) == 1
            and all(
                g.get("permissionKey") == "commentary:view" and g.get("scope") is None
                for g in viewer.get("grants", [])
            ),
        )

    def ensure_project(self, cid):
        body = {
            "name": "UAIN cancer research — evidence mirror",
            "description": canonical(SOURCE),
            "status": "backlog",
            "visibility": "private",
            "leadAgentId": None,
            "idempotencyKey": "baink-evidence-mirror-v1:" + self.s["bootstrapId"],
        }
        path = "/api/companies/" + cid + "/projects"
        prior = self.s["operations"].get("project-create")
        if prior and prior["state"] != "returned":
            key = "project-receipt-" + str(len(self.s["operations"]))
            code, project = self.mutate(
                key, "owner", "POST", path, body, {"X-Paperclip-Receipt-Only": "true"}
            )
            need(code in (200, 204), "project_receipt_failed")
            if code == 200:
                need(UUID.fullmatch(project.get("id", "")), "project_binding_failed")
                prior.update(
                    state="returned",
                    status=200,
                    response=project,
                    recoveredByReceipt=key,
                )
                self.s["projectId"] = project["id"]
                self.save()
            else:
                code, project = self.mutate(
                    "project-create", "owner", "POST", path, body, retry=True
                )
                need(code in (200, 201), "project_create_failed")
        else:
            code, project = self.mutate("project-create", "owner", "POST", path, body)
            need(code in (200, 201), "project_create_failed")
        need(UUID.fullmatch(project.get("id", "")), "project_binding_failed")
        need(
            not self.s.get("projectId") or self.s["projectId"] == project["id"],
            "project_binding_failed",
        )
        self.s["projectId"] = project["id"]
        self.save()
        # A creation receipt proves the original intent, not current metadata.
        # Re-read the live owner-visible detail before any ACL/key operation.
        current = self.get("/api/projects/" + project["id"])
        projects = self.get(path)
        self.checked(
            "one-bound-private-project",
            isinstance(projects, list)
            and len(projects) == 1
            and projects[0].get("id") == project["id"]
            and current.get("id") == project["id"]
            and all(
                current.get(k) == body[k]
                for k in ("name", "description", "status", "visibility", "leadAgentId")
            )
            and current.get("companyId") == cid,
        )
        return project["id"]

    def ensure_acl(self, pid):
        path = "/api/projects/" + pid + "/access-members"
        acl = self.get(path)
        selected = [
            a
            for a in acl
            if a.get("subjectType") == "user"
            and a.get("subjectId") == self.s["viewerId"]
        ]
        if not selected:
            code, _ = self.http.request("GET", "/api/projects/" + pid, actor="viewer")
            self.checked("private-denied-before-acl", code in (401, 403, 404))
            code, _ = self.mutate(
                "viewer-project-acl",
                "owner",
                "POST",
                path,
                {"subjectType": "user", "subjectId": self.s["viewerId"]},
            )
            need(code == 201, "acl_failed")
        self.checked(
            "private-explicit-acl",
            len(
                [
                    a
                    for a in self.get(path)
                    if a.get("subjectType") == "user"
                    and a.get("subjectId") == self.s["viewerId"]
                ]
            )
            == 1,
        )

    def ensure_key(self, cid):
        if self.s.get("viewerBoardToken"):
            return
        code, challenge = self.mutate(
            "viewer-key-challenge",
            "anonymous",
            "POST",
            "/api/cli-auth/challenges",
            {
                "command": "BAINK private read bridge",
                "clientName": "BAINK Viewer",
                "requestedAccess": "board",
                "requestedCompanyId": cid,
            },
        )
        need(
            code == 201
            and UUID.fullmatch(challenge.get("id", ""))
            and re.fullmatch(
                r"pcp_board_[A-Za-z0-9_-]{16,4000}", challenge.get("boardApiToken", "")
            )
            and isinstance(challenge.get("token"), str),
            "challenge_failed",
        )
        code, approved = self.mutate(
            "viewer-key-approve",
            "viewer",
            "POST",
            "/api/cli-auth/challenges/" + challenge["id"] + "/approve",
            {"token": challenge["token"]},
            retry=True,
        )
        need(
            code == 200
            and approved.get("approved") is True
            and approved.get("userId") == self.s["viewerId"],
            "challenge_approval_failed",
        )
        self.s["viewerBoardToken"] = challenge["boardApiToken"]
        self.save()


def main(args):
    os.umask(0o077)
    need(os.getuid() == 0 and os.geteuid() == 0, "root_required")
    need(len(args) == 2 and args[0] in ("identities", "company"), "usage")
    path = Path(args[1])
    need(
        str(path).startswith("/var/lib/baink-paperclip/")
        and str(path) != "/var/lib/baink-paperclip/data"
        and not str(path).startswith("/var/lib/baink-paperclip/data/")
        and path == path.resolve(),
        "unsafe_custody",
    )
    for parent in path.parents:
        st = parent.lstat()
        need(
            stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and st.st_mode & 0o022 == 0,
            "unsafe_custody_parent",
        )
    custody = Custody(path)
    try:
        controller = Controller(custody, Transport(custody))
        result = getattr(controller, args[0])()
        print(json.dumps(result, separators=(",", ":")))
    finally:
        custody.close()


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Stop as error:
        print(
            json.dumps(
                {"status": "stopped", "code": str(error), "secretsPrinted": False}
            )
        )
        sys.exit(2)
    except KeyboardInterrupt:
        print('{"status":"interrupted","secretsPrinted":false}')
        sys.exit(130)
    except Exception:
        print('{"status":"stopped","code":"controller_failed","secretsPrinted":false}')
        sys.exit(1)
