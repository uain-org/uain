import importlib.util
import pathlib
import tempfile
import unittest
import os

p = pathlib.Path(__file__).with_name("provision-control-plane.py")
spec = importlib.util.spec_from_file_location("provision", p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Transport:
    def __init__(self):
        self.calls = []
        self.fail = False

    def request(
        self, method, path, body=None, actor="anonymous", bearer=None, headers=None
    ):
        self.calls.append((method, path, body, actor, bearer, headers))
        if self.fail:
            raise TimeoutError()
        return 201, {"id": "10000000-0000-4000-8000-000000000001"}


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name).resolve() / "private"
        self.store = m.Custody(self.dir)
        self.transport = Transport()
        self.c = m.Controller(self.store, self.transport)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_durable_secrets_and_private_permissions(self):
        self.assertEqual(self.dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.dir / "state.json").stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(
            self.c.s["credentials"]["owner"]["password"],
            self.c.s["credentials"]["viewer"]["password"],
        )
        self.assertNotEqual(
            self.c.s["credentials"]["owner"]["email"],
            self.c.s["credentials"]["viewer"]["email"],
        )

    def test_once_send_and_intent_conflict(self):
        self.c.mutate("company", "owner", "POST", "/api/companies", {"name": "one"})
        self.c.mutate("company", "owner", "POST", "/api/companies", {"name": "one"})
        self.assertEqual(len(self.transport.calls), 1)
        with self.assertRaises(m.Stop):
            self.c.mutate("company", "owner", "POST", "/api/companies", {"name": "two"})

    def test_uncertain_send_not_repeated_after_restart(self):
        self.transport.fail = True
        with self.assertRaises(m.Stop):
            self.c.mutate("company", "owner", "POST", "/api/companies", {"name": "one"})
        self.assertEqual(
            self.c.s["operations"]["company"]["state"], "response_uncertain"
        )
        self.transport.fail = False
        self.c = m.Controller(self.store, self.transport)
        with self.assertRaises(m.Stop):
            self.c.mutate("company", "owner", "POST", "/api/companies", {"name": "one"})
        self.assertEqual(len(self.transport.calls), 1)

    def test_disabled_signup_requires_explicit_code_and_same_viewer(self):
        self.transport.request = lambda method, path, body=None, **kw: (
            400,
            {"code": "EMAIL_PASSWORD_SIGN_UP_DISABLED"},
        )
        self.c.disabled_signup()
        self.assertTrue(self.c.s["signupClosed"])
        self.c.s["operations"].clear()
        self.transport.request = lambda *a, **kw: (
            422,
            {"code": "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"},
        )
        with self.assertRaises(m.Stop):
            self.c.disabled_signup()

    def test_wrong_viewer_scope_admin_or_role_rejected(self):
        self.c.s.update(
            viewerId="viewer", companyId="10000000-0000-4000-8000-000000000001"
        )
        good = {
            "userId": "viewer",
            "isInstanceAdmin": False,
            "source": "board_key",
            "companyIds": [self.c.s["companyId"]],
            "memberships": [
                {
                    "companyId": self.c.s["companyId"],
                    "status": "active",
                    "membershipRole": "viewer",
                }
            ],
            "keyId": "20000000-0000-4000-8000-000000000002",
        }
        self.c.validate_viewer(good, True)
        for field, value in [
            ("isInstanceAdmin", True),
            ("companyIds", []),
            ("userId", "foreign"),
        ]:
            bad = dict(good)
            bad[field] = value
            with self.assertRaises(m.Stop):
                self.c.validate_viewer(bad, True)

    def test_transport_rejects_arbitrary_origin_and_redirects_before_open(self):
        t = m.Transport(self.store)
        for path in [
            "https://evil.test/api/health",
            "//evil/api/health",
            "/api/../admin",
            "/api/health#x",
        ]:
            with self.assertRaises(m.Stop):
                t.request("GET", path)

    def test_custody_refuses_unsafe_file_mode(self):
        os.chmod(self.dir / "state.json", 0o644)
        with self.assertRaises(m.Stop):
            self.store.read("state.json")


CID = "10000000-0000-4000-8000-000000000001"
PID = "20000000-0000-4000-8000-000000000002"
KEYID = "30000000-0000-4000-8000-000000000003"
CHID = "40000000-0000-4000-8000-000000000004"


class Fake:
    def __init__(self):
        self.calls = []
        self.users = set()
        self.emails = set()
        self.admin = False
        self.joined = False
        self.closed = False
        self.company = None
        self.project = None
        self.acl = False
        self.approved = False
        self.fault = None
        self.faulted = False

    def me(self, who, bearer=None):
        actor = "viewer" if bearer else who
        if actor not in self.users or (bearer and not self.approved):
            return 401, {}
        cid = [CID] if self.company and (actor == "owner" or self.joined) else []
        return 200, {
            "userId": actor,
            "source": "board_key" if bearer else "session",
            "isInstanceAdmin": self.admin if actor == "owner" else False,
            "companyIds": cid,
            "memberships": [
                {
                    "companyId": CID,
                    "status": "active",
                    "membershipRole": "owner" if actor == "owner" else "viewer",
                }
            ]
            if cid
            else [],
            "keyId": KEYID if bearer else None,
        }

    def request(
        self, method, path, body=None, actor="anonymous", bearer=None, headers=None
    ):
        self.calls.append((method, path, body, actor, bearer, headers))
        owner = actor == "owner" and not bearer
        viewer = actor == "viewer" or bool(bearer)
        if path == "/api/health":
            return 200, {
                "status": "ok",
                "commit": m.REVISION,
                "deploymentMode": "authenticated",
                "deploymentExposure": "private",
                **({"authReady": True} if actor != "anonymous" else {}),
                "bootstrapStatus": "ready" if self.admin else "bootstrap_pending",
            }
        if path == "/api/cli-auth/me":
            return self.me(actor, bearer)
        if path == "/api/auth/sign-up/email":
            if self.closed:
                return 400, {"code": "EMAIL_PASSWORD_SIGN_UP_DISABLED"}
            if body["email"] in self.emails:
                return 422, {"code": "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"}
            self.users.add(actor)
            self.emails.add(body["email"])
            return 200, {"user": {"id": actor}}
        if path == "/api/auth/sign-in/email":
            return 200, {}
        if path == "/api/bootstrap/claim":
            self.admin = True
            return 200, {"claimed": True, "userId": "owner"}
        if path == "/api/companies":
            if method == "GET":
                return 200, [] if not self.company else [self.company]
            if self.fault == "company-before" and not self.faulted:
                self.faulted = True
                raise TimeoutError()
            self.company = {**body, "id": CID}
            if self.fault == "company-after" and not self.faulted:
                self.faulted = True
                raise TimeoutError()
            return 201, self.company
        if path == "/api/companies/" + CID:
            return (200, self.company) if owner or viewer else (403, {})
        if path.endswith("/members"):
            if not owner:
                return 403, {}
            return 200, {
                "members": [
                    {
                        "principalId": "owner",
                        "membershipRole": "owner",
                        "status": "active",
                        "grants": [],
                    },
                    {
                        "principalId": "viewer",
                        "membershipRole": "viewer",
                        "status": "active",
                        "grants": [{"permissionKey": "commentary:view", "scope": None}],
                    },
                ]
            }
        if path.endswith(("/agents", "/routines", "/issues")):
            return 200, []
        if path.endswith("/invites"):
            return 201, {"token": "pcp_invite_" + "a" * 24}
        if path.endswith("/accept"):
            self.joined = True
            return 202, {"status": "approved"}
        if path == "/api/companies/" + CID + "/projects":
            if method == "GET":
                return 200, [] if not self.project else [self.project]
            if headers and headers.get("X-Paperclip-Receipt-Only") == "true":
                return (200, self.project) if self.project else (204, None)
            self.project = {**body, "id": PID, "companyId": CID}
            if self.fault == "project-after" and not self.faulted:
                self.faulted = True
                raise TimeoutError()
            return 201, self.project
        if path == "/api/projects/" + PID:
            if method == "PATCH":
                return (200, self.project) if owner else (403, {})
            return (200, self.project) if owner or (viewer and self.acl) else (403, {})
        if path.endswith("/access-members"):
            if method == "POST":
                self.acl = True
                return 201, {"subjectType": "user", "subjectId": "viewer"}
            return 200, [
                {"subjectType": "user", "subjectId": "viewer"}
            ] if self.acl else []
        if path == "/api/cli-auth/challenges":
            return 201, {
                "id": CHID,
                "token": "x" * 32,
                "boardApiToken": "pcp_board_" + "b" * 32,
            }
        if path.endswith("/approve"):
            self.approved = True
            if self.fault == "approval-after" and not self.faulted:
                self.faulted = True
                raise TimeoutError()
            return 200, {"approved": True, "userId": "viewer", "keyId": KEYID}
        raise AssertionError("unexpected fixed request")


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = m.Custody(pathlib.Path(self.tmp.name).resolve() / "private")
        self.t = Fake()
        self.c = m.Controller(self.store, self.t)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def ready(self):
        self.assertEqual(self.c.identities()["phase"], "identities")
        self.t.closed = True

    def test_full_two_phase_only_two_users_one_company_one_mirror(self):
        self.ready()
        self.assertEqual(self.c.company()["status"], "passed")
        self.c = m.Controller(self.store, self.t)
        self.assertEqual(self.c.company()["status"], "passed")
        self.assertEqual(
            len(
                [
                    x
                    for x in self.t.calls
                    if x[0] == "POST"
                    and x[1] == "/api/auth/sign-up/email"
                    and x[3] != "anonymous"
                ]
            ),
            2,
        )
        self.assertEqual(
            len([x for x in self.t.calls if x[:2] == ("POST", "/api/companies")]), 1
        )
        self.assertEqual(
            len(
                [
                    x
                    for x in self.t.calls
                    if x[:2] == ("POST", "/api/companies/" + CID + "/projects")
                    and not x[5]
                ]
            ),
            1,
        )
        self.assertEqual(self.t.users, {"owner", "viewer"})
        self.assertFalse(
            any(
                x[0] != "GET" and x[1].endswith(("/agents", "/routines", "/issues"))
                for x in self.t.calls
            )
        )

    def test_company_unknown_committed_reconciles_without_second_send(self):
        self.ready()
        self.t.fault = "company-after"
        with self.assertRaises(m.Stop):
            self.c.company()
        self.c = m.Controller(self.store, self.t)
        self.assertEqual(self.c.company()["status"], "passed")
        self.assertEqual(
            len([x for x in self.t.calls if x[:2] == ("POST", "/api/companies")]), 1
        )

    def test_company_unknown_absent_does_not_resend(self):
        self.ready()
        self.t.fault = "company-before"
        with self.assertRaises(m.Stop):
            self.c.company()
        self.c = m.Controller(self.store, self.t)
        with self.assertRaises(m.Stop):
            self.c.company()
        self.assertEqual(
            len([x for x in self.t.calls if x[:2] == ("POST", "/api/companies")]), 1
        )

    def test_project_unknown_commit_recovers_exact_receipt(self):
        self.ready()
        self.t.fault = "project-after"
        with self.assertRaises(m.Stop):
            self.c.company()
        self.c = m.Controller(self.store, self.t)
        self.assertEqual(self.c.company()["status"], "passed")
        self.assertEqual(self.c.s["operations"]["project-create"]["state"], "returned")

    def test_key_approval_unknown_retries_same_challenge_only(self):
        self.ready()
        self.t.fault = "approval-after"
        with self.assertRaises(m.Stop):
            self.c.company()
        self.c = m.Controller(self.store, self.t)
        self.assertEqual(self.c.company()["status"], "passed")
        self.assertEqual(
            len(
                [
                    x
                    for x in self.t.calls
                    if x[:2] == ("POST", "/api/cli-auth/challenges")
                ]
            ),
            1,
        )

    def test_signup_not_closed_no_company_write(self):
        self.c.identities()
        with self.assertRaises(m.Stop):
            self.c.company()
        self.assertFalse(any(x[:2] == ("POST", "/api/companies") for x in self.t.calls))
        self.assertEqual(len(self.t.users), 2)


class ConfinementTests(unittest.TestCase):
    def test_forbidden_write_family_rejected_before_network(self):
        with tempfile.TemporaryDirectory() as d:
            store = m.Custody(pathlib.Path(d).resolve() / "private")
            try:
                transport = m.Transport(store)

                class Opener:
                    def open(self, *a, **kw):
                        raise AssertionError("unallowed endpoint reached opener")

                transport.clients["anonymous"] = Opener()
                for method, path, body in [
                    ("POST", "/api/companies/" + CID + "/agents", {}),
                    ("POST", "/api/companies/" + CID + "/issues", {}),
                    ("POST", "/api/native/command", {}),
                    ("PATCH", "/api/projects/" + PID, {"leadAgentId": "foreign"}),
                    ("GET", "/api/health?target=evil", None),
                ]:
                    with self.assertRaises(m.Stop):
                        transport.request(method, path, body)
            finally:
                store.close()


class CookieTests(unittest.TestCase):
    def test_failed_cookie_replace_retains_prior_jar(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as d:
            store = m.Custody(pathlib.Path(d).resolve() / "private")
            try:
                filename = store.path / "owner-cookies.txt"
                old = "#LWP-Cookies-2.0\n# retained prior cookie jar\n"
                filename.write_text(old)
                filename.chmod(0o600)
                t = m.Transport(store)

                class Response:
                    status = 200
                    headers = {"Content-Type": "application/json"}

                    def __enter__(self):
                        return self

                    def __exit__(self, *a):
                        pass

                    def read(self, *a):
                        return b"{}"

                class Opener:
                    def open(self, *a, **kw):
                        return Response()

                t.clients["owner"] = Opener()
                with patch.object(
                    m.os,
                    "replace",
                    side_effect=OSError("simulated atomic replace failure"),
                ):
                    with self.assertRaises(OSError):
                        t.request("GET", "/api/health", actor="owner")
                self.assertEqual(filename.read_text(), old)
            finally:
                store.close()


class CurrentSourceBindingTests(unittest.TestCase):
    setUp = FlowTests.setUp
    tearDown = FlowTests.tearDown
    ready = FlowTests.ready

    def test_current_source_drift_cannot_hide_behind_cached_creation_receipt(self):
        self.ready()
        self.assertEqual(self.c.company()["status"], "passed")
        self.t.project = {
            **self.t.project,
            "description": "different-source",
            "status": "in_progress",
        }
        self.c = m.Controller(self.store, self.t)
        with self.assertRaises(m.Stop):
            self.c.company()


class HealthContractTests(unittest.TestCase):
    setUp = FlowTests.setUp
    tearDown = FlowTests.tearDown
    ready = FlowTests.ready

    def test_anonymous_health_omits_auth_ready_but_bootstrap_succeeds(self):
        code, body = self.t.request("GET", "/api/health")
        self.assertEqual(code, 200)
        self.assertNotIn("authReady", body)
        self.assertEqual(self.c.identities()["status"], "passed")
        self.assertIn("authenticated-runtime-ready", self.c.s["checks"])

    def test_authenticated_owner_health_requires_auth_ready(self):
        original = self.t.request

        def request(method, path, body=None, actor="anonymous", **kwargs):
            code, data = original(method, path, body, actor=actor, **kwargs)
            if path == "/api/health" and actor == "owner":
                data.pop("authReady", None)
            return code, data

        self.t.request = request
        with self.assertRaisesRegex(m.Stop, "authenticated-runtime-ready"):
            self.c.identities()
        self.assertEqual(self.t.users, {"owner"})

    def test_unrelated_company_is_not_adopted(self):
        self.ready()
        self.t.company = {"id": CID, "name": "unrelated private tenant"}
        with self.assertRaises(m.Stop):
            self.c.company()
        self.assertFalse(any(x[:2] == ("POST", "/api/companies") for x in self.t.calls))


class EntryPolicyTests(unittest.TestCase):
    def test_nonroot_entry_stops_before_transport(self):
        from unittest.mock import patch

        with (
            patch.object(m.os, "getuid", return_value=501),
            patch.object(m.os, "geteuid", return_value=501),
        ):
            with self.assertRaisesRegex(m.Stop, "root_required"):
                m.main(["identities", "/var/lib/baink-paperclip/bootstrap"])

    def test_custody_cannot_live_inside_container_data_mount(self):
        from unittest.mock import patch

        with (
            patch.object(m.os, "getuid", return_value=0),
            patch.object(m.os, "geteuid", return_value=0),
            patch.object(m.Path, "resolve", lambda self: self),
            patch.object(
                m.Path,
                "lstat",
                side_effect=AssertionError("data subtree reached filesystem"),
            ),
        ):
            with self.assertRaisesRegex(m.Stop, "unsafe_custody"):
                m.main(["identities", "/var/lib/baink-paperclip/data/private"])


if __name__ == "__main__":
    unittest.main()
