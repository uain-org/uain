// One plain line under a submission that waits for review: how many reviews are ahead of it and how
// many the reviewer starts in an hour. It reads BAINK's public, cached queue figure
// (/api/public/review-queue) at most once a minute for the whole page, and shows nothing when the
// figure cannot be read. No time is promised.
import { useEffect, useState } from "react";
import { api } from "./identity.js";
import { reviewQueueLine } from "./central-submission-status.js";

let kept = null, keptAt = 0, flight = null;
function readQueue() {
  if (kept && Date.now() - keptAt < 60_000) return Promise.resolve(kept);
  flight ??= api("/api/public/review-queue")
    .then((q) => { kept = q; keptAt = Date.now(); return q; }, () => null)
    .finally(() => { flight = null; });
  return flight;
}

export default function ReviewQueueNote({ sentAt }) {
  const [queue, setQueue] = useState(kept);
  useEffect(() => {
    let live = true;
    readQueue().then((q) => { if (live) setQueue(q); });
    return () => { live = false; };
  }, [sentAt]);
  const line = reviewQueueLine(queue, sentAt);
  return line ? <small className="review-delay" role="note" data-review-queue>{line}</small> : null;
}
