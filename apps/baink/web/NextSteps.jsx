import React, { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "./identity.js";
import { createRefreshLoop } from "./refresh-loop.js";
import { loadOpenTasks } from "./central-submission-status.js";
import { centralTaskOpen } from "./central-task-actions.js";
import { nextStepsView } from "./next-steps.js";

const SUBMISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

// "What can I do now?" on the first screen after sign-in. Reads only; each
// screen it points to checks its own facts again before anything is signed.
async function readFacts(identity, live) {
  const get = (path) => api(path, { identity, isCurrent: live });
  const [open, status, intents] = await Promise.all([
    loadOpenTasks(async (cursor, limit) => {
      const data = await get(`/api/native/central/tasks?cursor=${encodeURIComponent(cursor)}&limit=${limit}&order=newest&state=open`);
      return live() ? data : undefined;
    }).catch(() => null),
    get("/api/native/central/status").catch(() => null),
    get("/api/native/central/intents").catch(() => null),
  ]);
  // Your newest few recorded submissions: does any wait for more evidence?
  const mine = (Array.isArray(intents?.intents) ? intents.intents : [])
    .filter((i) => i?.command?.operation === "central_submit" && i.finalized === true && SUBMISSION_ID.test(i.command.payload?.id ?? ""))
    .slice(0, 4);
  const reads = await Promise.all(
    mine.map((i) => get(`/api/native/central/submissions/${encodeURIComponent(i.command.payload.id)}`).catch(() => null)),
  );
  const evidence = reads.filter((r) => r?.evidence?.kind === "reviewer_request" && r.evidence.window?.open === true).length;
  return {
    openTasks: open ? open.list.filter(centralTaskOpen).length : null,
    openPartial: open ? !open.complete : false,
    // Karma unreadable gives total 0 with this reason: then the points are unknown, not 0.
    points: Number.isSafeInteger(status?.contribution?.points?.total) && status.contribution.points.incompleteBecause !== "karma_unreadable" ? status.contribution.points.total : null,
    earned: typeof status?.earnings?.total === "string" ? status.earnings.total : null,
    evidence: intents ? evidence : null,
  };
}

export default function NextSteps({ identity, earningLive, needsJoin = false, incoming = [], navigate }) {
  const [facts, setFacts] = useState({});
  useEffect(() => {
    if (!identity || !earningLive) return undefined;
    let live = true;
    const read = async () => {
      try {
        const f = await readFacts(identity, () => live);
        if (live) setFacts(f);
        return true;
      } catch {
        return false;
      }
    };
    read();
    const loop = createRefreshLoop({ intervalMs: 60000, maxIntervalMs: 5 * 60000, run: read });
    return () => {
      live = false;
      loop.stop();
    };
  }, [identity, earningLive]);
  const toPay = (Array.isArray(incoming) ? incoming : []).filter((r) => r?.status === "open" && r.payment?.locked !== true).length;
  const view = nextStepsView({ ...facts, toPay, earningLive, needsJoin });
  return (
    <section className="panel ov-next" aria-label="What you can do now">
      <h2>What you can do now</h2>
      <ul>
        {view.items.map((i) => (
          <li key={i.key}>
            {i.tab ? (
              <button type="button" className="ov-balance-action" onClick={() => navigate(i.tab)}>
                {i.text} <ArrowRight size={12} aria-hidden="true" />
              </button>
            ) : (
              i.text
            )}
          </li>
        ))}
      </ul>
      {view.primary && (
        <p>
          <button type="button" className="button ink small" onClick={() => navigate(view.primary.tab)}>
            {view.primary.label} <ArrowRight size={16} aria-hidden="true" />
          </button>
        </p>
      )}
    </section>
  );
}
