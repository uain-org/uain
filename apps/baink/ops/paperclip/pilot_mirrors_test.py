import copy
import importlib.util
import pathlib
import tempfile
import unittest
import json

p = pathlib.Path(__file__).with_name("pilot-mirrors.py")
spec = importlib.util.spec_from_file_location("mirrors", p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
CID = "10000000-0000-4000-8000-000000000001"
PID = "20000000-0000-4000-8000-000000000001"
VID = "viewer-user"


def selection():
    groups = []
    first = []
    for n, (pid, ids) in enumerate(m.EXPECTED.items()):
        first.append(
            {
                "existingNativeProject": {
                    "id": pid,
                    "title": "Existing source project",
                    "state": "active",
                },
                "selectedWorkbookAnchor": {
                    "catalogueId": ["PRB-00505", "PRB-00025", "OPP-00016"][n]
                },
            }
        )
        groups.append(
            {
                "projectId": pid,
                "responseSha256": "a" * 64,
                "authority": "native",
                "pagesExhausted": True,
                "tasks": [
                    {
                        "id": tid,
                        "title": "Existing bounded question",
                        "status": "answered" if i == 0 else "open",
                        "submissionCount": 1,
                        "sourceKarmaPrice": None,
                        "url": "https://uain.global/api/tasks/" + tid,
                    }
                    for i, tid in enumerate(ids)
                ],
            }
        )
    return {
        "schema": "baink/pilot-project-selection/v1",
        "source": {"workbookSha256": m.WORKBOOK},
        "stageOne": first,
        "existingNativeTasks": groups,
    }


class FakeBootstrap:
    def __init__(self, store, http):
        self.custody = store
        self.http = http
        self.s = {
            "companyComplete": True,
            "bootstrapId": "30000000-0000-4000-8000-000000000001",
            "companyId": CID,
            "projectId": PID,
            "ownerId": "owner-user",
            "viewerId": VID,
            "viewerBoardToken": "fixture-private-token",
            "operations": {
                "viewer-project-acl": {
                    "state": "returned",
                    "status": 201,
                    "response": copy.deepcopy(http.acl[PID][0]),
                }
            },
        }

    def session(self, actor):
        return {"userId": self.s[actor + "Id"], "isInstanceAdmin": actor == "owner"}

    def validate_viewer(self, me, bearer=False):
        m.need(
            me.get("userId") == VID and me.get("isInstanceAdmin") is False,
            "viewer_scope_failed",
        )


class FakeHTTP:
    def __init__(self):
        self.calls = []
        self.projects = [
            {
                "id": PID,
                "companyId": CID,
                "name": "UAIN cancer research — evidence mirror",
                "description": m.base.canonical(m.base.SOURCE),
                "status": "backlog",
                "visibility": "private",
                "leadAgentId": None,
                "workspaces": [],
            }
        ]
        self.issues = []
        self.acl = {
            PID: [
                {
                    "id": "50000000-0000-4000-8000-000000000001",
                    "companyId": CID,
                    "projectId": PID,
                    "subjectType": "user",
                    "subjectId": VID,
                }
            ]
        }
        self.fail_after = None
        self.fail_before = None
        self.agents = []

    def request(
        self, method, path, body=None, actor="owner", bearer=None, headers=None
    ):
        self.calls.append((method, path, copy.deepcopy(body), actor))
        if method == "GET":
            if path == "/api/health":
                return 200, {
                    "status": "ok",
                    "commit": m.base.REVISION,
                    "deploymentMode": "authenticated",
                    "deploymentExposure": "private",
                    "authReady": True,
                }
            if path == "/api/cli-auth/me":
                return 200, {"userId": VID, "isInstanceAdmin": False}
            if path == "/api/companies":
                return 200, [{"id": CID}]
            if path == f"/api/companies/{CID}":
                return 200, {
                    "id": CID,
                    "budgetMonthlyCents": 0,
                    "issueCounter": len(self.issues),
                }
            if path.endswith("/agents"):
                return 200, self.agents
            if path.endswith("/routines"):
                return 200, []
            if path.endswith("/projects"):
                return 200, self.projects
            if path.endswith("/issues"):
                return 200, self.issues
            if path.endswith("/access-members"):
                return 200, self.acl.get(path.split("/")[3], [])
            if path.startswith("/api/projects/"):
                return 200, next(
                    x for x in self.projects if x["id"] == path.split("/")[3]
                )
        if self.fail_before and self.fail_before in path:
            raise TimeoutError("private-upstream-detail")
        if method == "POST" and path.endswith("/projects"):
            row = {
                **body,
                "id": f"20000000-0000-4000-8000-{len(self.projects) + 1:012d}",
                "companyId": CID,
                "privacyOwnerUserId": "owner-user",
                "workspaces": [],
            }
            self.projects.append(row)
            self.acl[row["id"]] = []
        elif method == "POST" and path.endswith("/access-members"):
            row = {
                **body,
                "id": f"50000000-0000-4000-8000-{sum(len(x) for x in self.acl.values()) + 1:012d}",
                "companyId": CID,
                "projectId": path.split("/")[3],
            }
            self.acl[path.split("/")[3]].append(row)
        elif method == "POST" and path.endswith("/issues"):
            selected = next(p for p in self.projects if p["id"] == body["projectId"])
            row = {
                **body,
                "visibility": "private"
                if selected["visibility"] == "private"
                else body["visibility"],
                "id": f"40000000-0000-4000-8000-{len(self.issues) + 1:012d}",
                "companyId": CID,
                "createdByUserId": "owner-user",
            }
            self.issues.append(row)
        else:
            raise AssertionError((method, path))
        if self.fail_after and self.fail_after in path:
            self.fail_after = None
            raise TimeoutError("private-upstream-detail")
        return 201, row


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = m.base.Custody(pathlib.Path(self.tmp.name).resolve() / "private")
        self.http = FakeHTTP()
        self.boot = FakeBootstrap(self.store, self.http)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def ctrl(self):
        return m.MirrorController(self.boot, m.plan(selection()))

    def test_plan_is_exactly_three_existing_and_fourteen_unassigned_nonpaying_mirrors(
        self,
    ):
        p = m.plan(selection())
        self.assertEqual(len(p["projects"]), 3)
        self.assertEqual(sum(len(x["tasks"]) for x in p["projects"]), 14)
        self.assertFalse(p["nativeWrites"])
        self.assertEqual(p["stageTwo"], "deferred")
        for x in p["projects"]:
            for t in x["tasks"]:
                self.assertIsNone(t["payload"]["assigneeAgentId"])
                self.assertIsNone(t["payload"]["assigneeUserId"])
                self.assertIsNone(t["source"]["sourceKarmaPrice"])
                self.assertIsNone(t["source"]["aiDollarPayment"])

    def test_reject_duplicate_wrong_group_source_and_unknown_status(self):
        for change in [
            lambda s: s["source"].update(workbookSha256="b" * 64),
            lambda s: s["stageOne"].pop(),
            lambda s: s["existingNativeTasks"][0]["tasks"][0].update(status="paid"),
            lambda s: s["existingNativeTasks"][0]["tasks"][1].update(id="T-35"),
        ]:
            s = selection()
            change(s)
            with self.assertRaises(m.base.Stop):
                m.plan(s)

    def test_apply_preserves_cancer_creates_two_private_projects_and_fourteen_issues_once(
        self,
    ):
        before = copy.deepcopy(self.http.projects[0])
        a = self.ctrl().apply()
        self.assertEqual(a["projects"], 3)
        self.assertEqual(a["issues"], 14)
        self.assertEqual(self.http.projects[0], before)
        count = len([x for x in self.http.calls if x[0] == "POST"])
        self.ctrl().apply()
        self.assertEqual(count, len([x for x in self.http.calls if x[0] == "POST"]))

    def test_uncertain_issue_reconciles_exact_committed_row_without_repost(self):
        self.http.fail_after = "/issues"
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(len(self.http.issues), 1)
        self.ctrl().apply()
        self.assertEqual(len(self.http.issues), 14)

    def test_absent_uncertain_issue_never_blindly_replayed(self):
        self.http.fail_before = "/issues"
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.http.fail_before = None
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(len(self.http.issues), 0)

    def test_drift_in_existing_project_or_nonzero_agent_fails_before_writes(self):
        for alter in [
            lambda: self.http.projects[0].update(leadAgentId="agent"),
            lambda: self.http.agents.append({"id": "agent"}),
        ]:
            alter()
            with self.assertRaises(m.base.Stop):
                self.ctrl().apply()
            self.assertFalse(any(x[0] == "POST" for x in self.http.calls))
            self.http = FakeHTTP()
            self.boot.http = self.http

    def test_plan_drift_refuses_retained_journal(self):
        self.ctrl()
        p = m.plan(selection())
        p["selectionDigest"] = "b" * 64
        with self.assertRaises(m.base.Stop):
            m.MirrorController(self.boot, p)

    def test_source_hash_file_and_symlink_bounds(self):
        p = pathlib.Path(self.tmp.name).resolve() / "selection.json"
        p.write_text(json.dumps(selection()))
        p.chmod(0o600)
        digest = m.hashlib.sha256(p.read_bytes()).hexdigest()
        self.assertEqual(m.load_selection(p, digest), selection())
        with self.assertRaises(m.base.Stop):
            m.load_selection(p, "b" * 64)
        link = p.parent / "link.json"
        link.symlink_to(p)
        with self.assertRaises(m.base.Stop):
            m.load_selection(link, digest)

    def test_custody_exclusive_and_source_journal_no_credentials(self):
        self.ctrl()
        with self.assertRaises(m.base.Stop):
            m.base.Custody(self.store.path)
        raw = (self.store.path / "pilot-mirrors.json").read_text()
        self.assertNotIn("fixture-private-token", raw)
        self.assertNotIn("password", raw)

    def test_unknown_issue_and_foreign_acl_stop_before_any_mutation(self):
        for setup in [
            lambda: self.http.issues.append(
                {
                    "id": "40000000-0000-4000-8000-999999999999",
                    "companyId": CID,
                    "description": "unrelated existing work",
                }
            ),
            lambda: self.http.acl[PID].append(
                {"subjectType": "user", "subjectId": "another-user"}
            ),
        ]:
            setup()
            with self.assertRaises(m.base.Stop):
                self.ctrl().apply()
            self.assertFalse(any(x[0] == "POST" for x in self.http.calls))
            self.http = FakeHTTP()
            self.boot.http = self.http

    def test_uncertain_project_and_acl_commit_reconcile_without_duplicate_rows(self):
        for target in ["/projects", "/access-members"]:
            self.http.fail_after = target
            with self.assertRaises(m.base.Stop):
                self.ctrl().apply()
            result = self.ctrl().apply()
            self.assertEqual(result["issues"], 14)
            self.assertEqual(len(self.http.projects), 3)
            self.assertTrue(
                all(
                    op["state"] == "returned"
                    for op in self.ctrl().j["operations"].values()
                )
            )
            # A new fixture is established explicitly for the second independent failure.
            self.store.close()
            self.tmp.cleanup()
            self.tmp = tempfile.TemporaryDirectory()
            self.store = m.base.Custody(
                pathlib.Path(self.tmp.name).resolve() / "private"
            )
            self.http = FakeHTTP()
            self.boot = FakeBootstrap(self.store, self.http)

    def test_mirror_status_is_not_native_scientific_verification_or_money(self):
        p = m.plan(selection())
        for project in p["projects"]:
            for task in project["tasks"]:
                self.assertEqual(
                    task["source"]["nativeStatus"],
                    "answered"
                    if task["nativeTaskId"] in ["T-35", "T-39", "T-43"]
                    else "open",
                )
                self.assertIsNone(task["source"]["scientificVerification"])
                self.assertIsNone(task["source"]["aiDollarPayment"])

    def test_viewer_read_denial_never_claims_complete(self):
        original = self.http.request

        def denied(method, path, body=None, actor="owner", **kw):
            if actor == "anonymous" and path.startswith("/api/projects/"):
                return 403, {"error": "private details"}
            return original(method, path, body, actor=actor, **kw)

        self.http.request = denied
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertFalse(self.ctrl().j.get("complete", False))
        self.assertEqual(len(self.http.issues), 0)

    def test_returned_issue_drift_is_not_silently_overwritten(self):
        self.ctrl().apply()
        self.http.issues[0]["status"] = "in_progress"
        before = len([x for x in self.http.calls if x[0] == "POST"])
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))

    def test_transport_refuses_extra_endpoints_and_assigned_issue_payload(self):
        transport = m.MirrorTransport(self.store, CID)
        for method, path, body in [
            ("POST", f"/api/companies/{CID}/invites", {}),
            ("POST", "/api/auth/sign-up/email", {}),
            ("PATCH", "/api/projects/" + PID, {}),
            ("POST", f"/api/companies/{CID}/issues", {"assigneeAgentId": "agent"}),
        ]:
            with self.assertRaises(m.base.Stop):
                transport.request(method, path, body, actor="owner")

    def test_returned_watchdog_and_execution_metadata_are_not_ignored(self):
        self.ctrl().apply()
        self.http.issues[0]["watchdog"] = {"agentId": "unexpected"}
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()

    def test_returned_issue_and_project_ids_cannot_be_rebound_to_clones(self):
        self.ctrl().apply()
        before = len([x for x in self.http.calls if x[0] == "POST"])
        original = self.http.issues[0]["id"]
        self.http.issues[0]["id"] = "40000000-0000-4000-8000-999999999999"
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(self.ctrl().j["issues"]["T-35"], original)
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))
        self.http.issues[0]["id"] = original
        self.http.projects[1]["id"] = "20000000-0000-4000-8000-999999999999"
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))

    def test_exact_foreign_late_issue_requires_prior_journal_before_any_writes(self):
        desired = m.plan(selection())
        task = next(
            t
            for p in desired["projects"]
            for t in p["tasks"]
            if t["nativeTaskId"] == "T-48"
        )
        self.http.issues.append(
            {
                **task["payload"],
                "projectId": PID,
                "id": "40000000-0000-4000-8000-999999999998",
                "companyId": CID,
                "createdByUserId": "owner-user",
            }
        )
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertFalse(any(x[0] == "POST" for x in self.http.calls))

    def test_duplicate_source_issue_or_acl_inventory_stops_before_any_new_writes(self):
        self.ctrl().apply()
        self.http.issues.pop()
        self.http.issues.append(
            {**self.http.issues[0], "id": "40000000-0000-4000-8000-999999999997"}
        )
        before = len([x for x in self.http.calls if x[0] == "POST"])
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))
        self.http.issues.pop()
        self.http.acl[PID].append({"subjectType": "user", "subjectId": VID})
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))

    def test_prepared_intent_cannot_adopt_existing_issue_row(self):
        self.ctrl().apply()
        controller = self.ctrl()
        controller.j["operations"]["issue:T-48"]["state"] = "prepared"
        controller.j["operations"]["issue:T-48"].pop("id")
        controller.save()
        before = len([x for x in self.http.calls if x[0] == "POST"])
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))

    def test_unknown_or_prepared_viewer_acl_is_not_adopted_for_new_project(self):
        self.ctrl().apply()
        controller = self.ctrl()
        pid = controller.j["projects"][next(iter(m.EXPECTED))]
        key = "acl:" + pid
        controller.j["operations"][key]["state"] = "prepared"
        controller.save()
        before = len([x for x in self.http.calls if x[0] == "POST"])
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))
        controller = self.ctrl()
        controller.j["operations"].pop(key)
        controller.save()
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))

    def test_original_cancer_viewer_revocation_is_never_autohealed(self):
        self.http.acl[PID] = []
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertFalse(any(x[0] == "POST" for x in self.http.calls))
        self.assertEqual(self.http.acl[PID], [])

    def test_returned_resources_and_new_viewer_acl_must_remain_present_in_preflight(
        self,
    ):
        self.ctrl().apply()
        before = len([x for x in self.http.calls if x[0] == "POST"])
        removed = self.http.issues.pop()
        with self.assertRaisesRegex(m.base.Stop, "^mirror_returned_resource_missing$"):
            self.ctrl().guard()
        self.http.issues.append(removed)
        pid = self.ctrl().j["projects"][next(iter(m.EXPECTED))]
        self.http.acl[pid] = []
        with self.assertRaisesRegex(m.base.Stop, "^acl_returned_resource_missing$"):
            self.ctrl().guard()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))

    def test_original_and_new_viewer_acl_uuids_are_immutable(self):
        self.ctrl().apply()
        before = len([x for x in self.http.calls if x[0] == "POST"])
        original = self.http.acl[PID][0]["id"]
        self.http.acl[PID][0]["id"] = "50000000-0000-4000-8000-999999999999"
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.http.acl[PID][0]["id"] = original
        pid = self.ctrl().j["projects"][next(iter(m.EXPECTED))]
        self.http.acl[pid][0]["id"] = "50000000-0000-4000-8000-999999999998"
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))

    def test_prepared_project_cannot_adopt_an_existing_source_exact_row(self):
        self.ctrl().apply()
        controller = self.ctrl()
        key = "project:" + next(iter(m.EXPECTED))
        controller.j["operations"][key]["state"] = "prepared"
        controller.j["operations"][key].pop("id")
        controller.save()
        before = len([x for x in self.http.calls if x[0] == "POST"])
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))

    def test_returned_new_project_requires_positive_viewer_read_in_global_preflight(
        self,
    ):
        self.ctrl().apply()
        pid = self.ctrl().j["projects"][next(iter(m.EXPECTED))]
        original = self.http.request

        def denied(method, path, body=None, actor="owner", **kw):
            if actor == "anonymous" and path == "/api/projects/" + pid:
                return 403, {"error": "denied"}
            return original(method, path, body, actor=actor, **kw)

        self.http.request = denied
        before = len([x for x in self.http.calls if x[0] == "POST"])
        with self.assertRaises(m.base.Stop):
            self.ctrl().guard()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))

    def test_actual_private_return_recovers_sent_t35_without_resend_or_intent_change(
        self,
    ):
        desired = m.plan(selection())
        before_digest = m.base.digest(desired)
        self.http.fail_after = "/issues"
        with self.assertRaises(m.base.Stop):
            self.ctrl().apply()
        self.assertEqual(len(self.http.issues), 1)
        row_id = self.http.issues[0]["id"]
        self.assertEqual(self.http.issues[0]["visibility"], "private")
        controller = self.ctrl()
        op = controller.j["operations"]["issue:T-35"]
        op["state"] = "send_started"
        op.pop("id", None)
        self.assertEqual(op["intent"]["body"]["visibility"], "open")
        original_intent = m.base.canonical(op["intent"])
        original_intent_digest = op["intentDigest"]
        controller.save()
        self.ctrl().apply()
        self.assertEqual(self.ctrl().j["issues"]["T-35"], row_id)
        posts = [
            call
            for call in self.http.calls
            if call[0] == "POST"
            and call[1].endswith("/issues")
            and call[2]["title"].startswith("Native T-35:")
        ]
        self.assertEqual(len(posts), 1)
        recovered = self.ctrl().j["operations"]["issue:T-35"]
        self.assertEqual(m.base.canonical(recovered["intent"]), original_intent)
        self.assertEqual(recovered["intentDigest"], original_intent_digest)
        self.assertEqual(self.ctrl().j["planDigest"], before_digest)
        self.assertEqual(m.base.digest(m.plan(selection())), before_digest)

    def test_private_project_issue_must_return_private_not_an_open_private_union(self):
        self.ctrl().apply()
        self.http.issues[0]["visibility"] = "open"
        before = len([x for x in self.http.calls if x[0] == "POST"])
        with self.assertRaises(m.base.Stop):
            self.ctrl().guard()
        self.assertEqual(before, len([x for x in self.http.calls if x[0] == "POST"]))


if __name__ == "__main__":
    unittest.main()
