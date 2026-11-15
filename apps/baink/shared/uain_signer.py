"""UAIN signer: earn on UAIN with nothing installed on the person's computer.

Run this file in your own code sandbox (for example the Python tool of a chat
assistant). It makes no network calls and needs no packages: it uses the
`cryptography` package for Ed25519 when it is importable and a small
pure-Python Ed25519 (RFC 8032) otherwise.

What it does, and nothing else:
  new_key()                      a new member key (the 43-character private key)
  address_of(private_key)        the member's uain1 address
  sign_request(...)              signs one BAINK request; returns the arguments
                                 for the MCP tool baink_member_request
  sign_prepared(...)             checks a prepared step, then signs it; returns
                                 the envelope to submit
  submission_id(...)             the same submission id for the same draft, so
                                 a retry never makes a second submission
  enrol_request_id(...)          the same enrolment request id for the same
                                 details
  survey_evidence(...)           the exact evidence text of a prior-art survey
  kit_identity_file(...)         the key as a uain-agent kit identity file, for
                                 a person who would rather keep it on disk

It signs only four kinds of step: enrol, project_join, central_submit and
central_reassess. It refuses every other operation, so it can never sign a
payment, a transfer or a Trade step.

The private key is shown to the person once to save. Anyone who has it can act
as them. Never send it to any server or tool: only signatures leave the sandbox.
The checksum of this file is published at https://baink.money/uain_signer.py.sha256.
"""

import base64
import hashlib
import json
import os
import re
import time
import calendar
from datetime import datetime, timezone

SIGNER_VERSION = "1"
AUDIENCE = "https://baink.money"
OPERATIONS = ("enrol", "project_join", "central_submit", "central_reassess")
FIELDS = ("version", "chain_id", "member", "sequence", "expires_height", "operation", "payload")
EVIDENCE_MAX = 16384
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
_UINT = re.compile(r"^(0|[1-9][0-9]{0,19})$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_KEY = re.compile(r"^[A-Za-z0-9_-]{43}$")


class SigningRefused(Exception):
    """Nothing was signed. The message says why, in plain words."""


def _insist(ok, message="The prepared step differs from what you asked for. Nothing was signed."):
    if not ok:
        raise SigningRefused(message)


# ------------------------------------------------------------------ base64
def _b64(raw):
    return base64.b64encode(raw).decode("ascii")


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sha256_hex(value):
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


# ------------------------------------------------------------------ Ed25519
# Pure Python, RFC 8032 section 6: always defined, used when no library is importable.
_p = 2**255 - 19
_q = 2**252 + 27742317777372353535851937790883648493
_d = -121665 * pow(121666, _p - 2, _p) % _p
_sqrt_m1 = pow(2, (_p - 1) // 4, _p)


def _add(P, Q):
    A = (P[1] - P[0]) * (Q[1] - Q[0]) % _p
    B = (P[1] + P[0]) * (Q[1] + Q[0]) % _p
    C = 2 * P[3] * Q[3] * _d % _p
    D = 2 * P[2] * Q[2] % _p
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _p, G * H % _p, F * G % _p, E * H % _p)


def _mul(s, P):
    Q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            Q = _add(Q, P)
        P = _add(P, P)
        s >>= 1
    return Q


def _x(y, sign):
    x2 = (y * y - 1) * pow(_d * y * y + 1, _p - 2, _p)
    x = pow(x2, (_p + 3) // 8, _p)
    if (x * x - x2) % _p:
        x = x * _sqrt_m1 % _p
    if (x & 1) != sign:
        x = _p - x
    return x


_gy = 4 * pow(5, _p - 2, _p) % _p
_gx = _x(_gy, 0)
_G = (_gx, _gy, 1, _gx * _gy % _p)


def _compress(P):
    zi = pow(P[2], _p - 2, _p)
    x, y = P[0] * zi % _p, P[1] * zi % _p
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _expand(seed):
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def pure_public(seed):
    return _compress(_mul(_expand(seed)[0], _G))


def pure_sign(seed, message):
    a, prefix = _expand(seed)
    A = _compress(_mul(a, _G))
    r = int.from_bytes(hashlib.sha512(prefix + message).digest(), "little") % _q
    R = _compress(_mul(r, _G))
    h = int.from_bytes(hashlib.sha512(R + A + message).digest(), "little") % _q
    return R + int.to_bytes((r + h * a) % _q, 32, "little")


try:  # A standard library when the sandbox has one.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as _Std
    from cryptography.hazmat.primitives import serialization as _ser

    def _public(seed):
        return _Std.from_private_bytes(seed).public_key().public_bytes(_ser.Encoding.Raw, _ser.PublicFormat.Raw)

    def _sign(seed, message):
        return _Std.from_private_bytes(seed).sign(message)

    ED25519 = "cryptography"
except Exception:
    _public, _sign, ED25519 = pure_public, pure_sign, "pure-python"


def _seed(private_key):
    _insist(isinstance(private_key, str) and _KEY.match(private_key.strip()) is not None,
            "That is not a member private key (43 letters, digits, - or _). Nothing was signed.")
    raw = _unb64url(private_key.strip())
    _insist(len(raw) == 32, "That is not a member private key. Nothing was signed.")
    return raw


# ------------------------------------------------------------------ identity
def new_key():
    """A new member key. Show privateKey to the person once and ask them to save it."""
    seed = os.urandom(32)
    return identity(_b64url(seed))


def identity(private_key):
    """Public key and address of a private key (the private key stays here)."""
    raw = _public(_seed(private_key))
    return {
        "privateKey": private_key.strip(),
        "publicKey": _b64(raw),
        "publicKeyUrl": _b64url(raw),
        "address": "uain1" + sha256_hex(raw)[:40],
    }


def address_of(private_key):
    return identity(private_key)["address"]


def kit_identity_file(private_key):
    """The same key as the uain-agent kit's identity.json, for a person who wants it in a file."""
    me = identity(private_key)
    return json.dumps({"format": "baink-identity-v2", "algorithm": "Ed25519", "address": me["address"],
                       "public_key": me["publicKeyUrl"], "private_key": me["privateKey"],
                       "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")}, indent=2) + "\n"


# ------------------------------------------------------------------ canonical forms
def plain_json(value):
    """Sorted-key JSON, byte-identical to the kit's plainJSON (JavaScript JSON.stringify)."""
    if isinstance(value, bool) or value is None:
        return json.dumps(value)
    if isinstance(value, int):
        _insist(abs(value) <= 9007199254740991, "Numbers must be safe integers. Nothing was signed.")
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(plain_json(v) for v in value) + "]"
    _insist(isinstance(value, dict), "Only JSON values can be signed. Nothing was signed.")
    # Keys in JavaScript's default order (UTF-16 code units), as Object.keys(...).sort().
    keys = sorted(value, key=lambda k: k.encode("utf-16-be", "surrogatepass"))
    return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + plain_json(value[k]) for k in keys) + "}"


def _quoted(text):
    _insist(isinstance(text, str), "A command field is not text. Nothing was signed.")
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        raise SigningRefused("A command field is not valid text. Nothing was signed.")
    out = json.dumps(text, ensure_ascii=False)
    return re.sub("[<>&\u2028\u2029]", lambda m: "\\u%04x" % ord(m.group(0)), out)


def native_json(value, depth=0):
    """Native command JSON: sorted keys; <, >, & and line separators escaped; safe integers only."""
    _insist(depth <= 16)
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _quoted(value)
    if isinstance(value, int):
        _insist(abs(value) <= 9007199254740991)
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(native_json(v, depth + 1) for v in value) + "]"
    _insist(isinstance(value, dict))
    return "{" + ",".join(_quoted(k) + ":" + native_json(value[k], depth + 1) for k in sorted(value)) + "}"


def command_bytes(c):
    """The exact bytes a member signs for a native command."""
    _insist(isinstance(c, dict) and sorted(c) == sorted(FIELDS) and c.get("version") == 1 and not isinstance(c.get("version"), bool))
    _insist(isinstance(c["chain_id"], str) and re.match(r"^[A-Za-z0-9._-]{1,96}$", c["chain_id"]) is not None)
    _insist(isinstance(c["member"], str) and re.match(r"^uain1[0-9a-f]{40}$", c["member"]) is not None)
    _insist(isinstance(c["sequence"], str) and _UINT.match(c["sequence"]) is not None and int(c["sequence"]) < 18446744073709551615)
    _insist(isinstance(c["expires_height"], str) and re.match(r"^[1-9][0-9]{0,18}$", c["expires_height"]) is not None
            and int(c["expires_height"]) <= 9223372036854775807, "The prepared step has no valid expiry. Nothing was signed.")
    return ("uain:chain-command:v1\n{" + ",".join(_quoted(k) + ":" + native_json(c[k]) for k in FIELDS) + "}").encode("utf-8")


# ------------------------------------------------------------------ stable ids (no local state needed)
def _uuid_shape(hexdigest):
    h = list(hexdigest[:32])
    h[12] = "4"
    h[16] = "89ab"[int(h[16], 16) & 3]
    h = "".join(h)
    return "%s-%s-%s-%s-%s" % (h[:8], h[8:12], h[12:16], h[16:20], h[20:32])


def submission_id(address, task, draft, revises=""):
    """The same id for the same member, task and draft, so a retry is never a second submission.

    draft: the evidence text, or for a survey the survey object (its exact content)."""
    text = draft if isinstance(draft, str) else plain_json(draft)
    seed = "uain-submission-id-v1\n%s\n%s\n%s\n%s" % (address, task, sha256_hex(text), revises or "")
    return "CS-" + _uuid_shape(sha256_hex(seed))


def enrol_request_id(address, name, operator, family=""):
    """The same enrolment request id for the same details."""
    details = plain_json({"name": name.strip(), "operator": operator.strip(), "family": family.strip()})
    return "enrol-" + sha256_hex("uain-enrol-request-v1\n%s\n%s" % (address, details))[:40]


# ------------------------------------------------------------------ prior-art survey evidence
KINDS = ("doi", "arxiv", "github", "pubmed", "nct", "wikidata")
RELATIONS = ("meets_main_kpi", "partial", "adjacent", "screened_out")


def normalize_id(kind, value):
    v = str(value or "").strip()
    if kind == "doi":
        v = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", v, flags=re.I).lower()
    if kind == "arxiv":
        v = re.sub(r"v[0-9]{1,3}$", "", re.sub(r"^arxiv:", "", v, flags=re.I).lower())
    if kind == "github":
        v = re.sub(r"\.git$", "", re.sub(r"^https?://github\.com/", "", v, flags=re.I), flags=re.I).lower()
    if kind in ("nct", "wikidata"):
        v = v.upper()
    return v


def survey(template, as_of, items, meets_main_kpi, gaps=()):
    """A survey object from the template (GET /api/native/central/survey-template/<task>).

    items: dicts with kind, id, title, relation, note. Keep every template["required"] item."""
    out = []
    for i in items:
        _insist(i.get("kind") in KINDS and i.get("relation") in RELATIONS, "Each item needs a known kind and relation.")
        out.append({"kind": i["kind"], "id": normalize_id(i["kind"], i["id"]), "title": i["title"].strip(),
                    "relation": i["relation"], "note": i["note"].strip()})
    _insist(re.match(r"^\d{4}-\d{2}-\d{2}$", as_of or "") is not None, "as_of is the survey date, YYYY-MM-DD.")
    for r in template.get("required", []):
        _insist(any(x["kind"] == r["kind"] and x["id"] == r["id"] for x in out), "Keep the item %s %s." % (r["kind"], r["id"]))
    included = [x for x in out if x["relation"] != "screened_out"]
    _insist(len(included) >= template.get("minIncluded", 0), "Add at least %s items that are not screened out." % template.get("minIncluded"))
    _insist(len({x["kind"] for x in included}) >= template.get("minKinds", 0), "Use at least %s kinds of source." % template.get("minKinds"))
    _insist(bool(meets_main_kpi) == any(x["relation"] == "meets_main_kpi" for x in out), "meets_main_kpi must match the items.")
    _insist(meets_main_kpi or len(gaps) > 0, "Add at least one gap.")
    return {"mainKpi": template["mainKpi"], "asOf": as_of, "items": out,
            "conclusion": {"meetsMainKpi": bool(meets_main_kpi), "gaps": [g.strip() for g in gaps]}}


def survey_evidence(task, submission, address, survey_object):
    """The exact evidence text of a prior-art survey (the kit's surveyEvidence)."""
    return plain_json({"author": address, "schema": "uain-evidence-artifact-v1", "submissionId": submission,
                       "survey": survey_object, "taskId": task})


# ------------------------------------------------------------------ signing
def sign_request(private_key, method, path, body=None, audience=AUDIENCE, now_ms=None, nonce=None):
    """Sign one BAINK request. Returns the arguments for the MCP tool baink_member_request.

    The signature is fresh for 5 minutes and is used once: sign again for every call."""
    me = identity(private_key)
    method = method.upper()
    _insist(method in ("GET", "POST"), "Use GET or POST. Nothing was signed.")
    _insist(isinstance(path, str) and path.startswith("/api/"), "The path starts with /api/. Nothing was signed.")
    signed_body = {} if method == "GET" or body is None else body
    nonce = nonce or _b64url(os.urandom(24))
    timestamp = str(int(now_ms if now_ms is not None else time.time() * 1000))
    message = plain_json({"audience": audience, "method": method, "path": path, "body": signed_body,
                          "nonce": nonce, "timestamp": timestamp})
    signature = _sign(_seed(private_key), message.encode("utf-8"))
    out = {"method": method, "path": path, "publicKey": me["publicKey"], "nonce": nonce,
           "timestamp": timestamp, "signature": _b64(signature)}
    if method != "GET":
        out["body"] = signed_body
    return out


def _proof_fresh(p, now):
    if not isinstance(p, dict) or p.get("authority") != "native":
        return False
    age = p.get("maxAgeSeconds")
    if not isinstance(age, int) or isinstance(age, bool) or not 1 <= age <= 120 or not isinstance(p.get("headerTime"), str):
        return False
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$", p["headerTime"])
    if not m:
        return False
    t = calendar.timegm(tuple(int(m.group(i)) for i in range(1, 7)) + (0, 0, 0)) + float(m.group(7) or 0)
    if m.group(8) != "Z":
        t -= (1 if m.group(9) == "+" else -1) * (int(m.group(10)) * 3600 + int(m.group(11)) * 60)
    return t <= now + 60 and now < t + age


def _payload_ok(operation, p):
    if operation == "enrol":
        return isinstance(p, dict) and sorted(p) == ["family", "name", "operator"] and all(isinstance(p[k], str) for k in p)
    if operation == "project_join":
        return isinstance(p, dict) and list(p) == ["project"] and isinstance(p["project"], str) and _ID.match(p["project"]) is not None
    if operation == "central_reassess":
        return isinstance(p, dict) and list(p) == ["submission"] and isinstance(p["submission"], str) and _ID.match(p["submission"]) is not None
    keys = ["evidence", "evidence_digest", "id", "task"] + (["revises"] if "revises" in (p or {}) else [])
    return (isinstance(p, dict) and sorted(p) == sorted(keys) and all(isinstance(p[k], str) for k in p)
            and _ID.match(p["id"]) is not None and _ID.match(p["task"]) is not None
            and ("revises" not in p or (_ID.match(p["revises"]) is not None and p["revises"] != p["id"]))
            and p["evidence"].strip() != "" and len(p["evidence"].encode("utf-8")) <= EVIDENCE_MAX
            and sha256_hex(p["evidence"]) == p["evidence_digest"])


def sign_prepared(private_key, intent, operation, payload, config=None, now=None):
    """Check a prepared step from BAINK, then sign it. Returns {command, public_key, signature}.

    intent: the "intent" the prepare call returned. operation and payload: what you asked
    BAINK to prepare. config: GET /api/config, to check the network the step is for."""
    me = identity(private_key)
    now = time.time() if now is None else now
    _insist(operation in OPERATIONS, "This signer signs only enrol, project_join, central_submit and central_reassess. "
            "Payments and Trade need the uain-agent kit. Nothing was signed.")
    _insist(isinstance(intent, dict) and intent.get("status") == "prepared",
            "This step is not waiting for a signature (it was sent earlier or has expired). Read it back with "
            "GET /api/native/central/intents; nothing was signed.")
    c = intent.get("command")
    _insist(isinstance(c, dict) and c.get("operation") in OPERATIONS, "The prepared step is not an earning step. Nothing was signed.")
    _insist(c["operation"] == operation, "The prepared step is a different operation from the one you asked for. Nothing was signed.")
    _insist(c.get("member") == me["address"] and intent.get("member", me["address"]) == me["address"],
            "The prepared step is for another member, not for this key. Nothing was signed.")
    _insist(native_json(c.get("payload")) == native_json(payload), "The prepared step's details differ from what you asked for. Nothing was signed.")
    _insist(_payload_ok(operation, payload), "The step's details are not valid (check the evidence digest and ids). Nothing was signed.")
    if operation == "enrol":
        _insist(c.get("sequence") == "0", "An enrolment is always the member's first step. Nothing was signed.")
    _insist(intent.get("publicKey") == me["publicKeyUrl"], "The prepared step names another public key. Nothing was signed.")
    raw = command_bytes(c)
    _insist(_b64(raw) == intent.get("signingBytesBase64"), "The bytes BAINK asks you to sign differ from the command. Nothing was signed.")
    _insist(intent.get("commandDigest") in (None, sha256_hex(raw)), "The command digest differs. Nothing was signed.")
    p = intent.get("proof") or {}
    _insist(isinstance(p.get("height"), str) and re.match(r"^[1-9][0-9]*$", p["height"]) is not None
            and int(p["height"]) < int(c["expires_height"]) <= int(p["height"]) + 100,
            "The step's expiry is missing or out of range. Prepare it again; nothing was signed.")
    _insist(_proof_fresh(p, now) and p.get("chainId") == c["chain_id"],
            "The network proof for this step is stale. Prepare it again; nothing was signed.")
    if config is not None:
        e = ((config or {}).get("nativeRegistration") or {}).get("enrol") or {}
        _insist(e.get("chainId") == c["chain_id"] and _HASH.match(e.get("genesisSha256") or "") is not None
                and p.get("epoch") == e["genesisSha256"] and p.get("genesisSha256") == e["genesisSha256"],
                "The step is for another network than BAINK publishes. Nothing was signed.")
    signature = _sign(_seed(private_key), raw)
    return {"command": json.loads(json.dumps(c)), "public_key": me["publicKeyUrl"], "signature": _b64url(signature)}


if __name__ == "__main__":
    print(json.dumps({"signer": SIGNER_VERSION, "ed25519": ED25519,
                      "use": "import this file and call new_key(), sign_request(...), sign_prepared(...)"}))
