'use client';
import { useState } from 'react';
import { countStage } from '@/lib/campaign/funnel';

/** One anonymous click, counted per day in aggregate. The stages are allowlisted by the pilot. */
const choices = [
  ['poll_unclear', 'Not sure what my system would actually do'],
  ['poll_cost', 'Worried about cost or model usage'],
  ['poll_safety', 'Worried about safety or control'],
  ['poll_setup', 'Setup looks too hard'],
  ['poll_not_relevant', 'Not relevant to my work'],
  ['poll_browsing', 'Just looking for now'],
] as const;

export function ExitPoll() {
  const [answered, setAnswered] = useState(false);
  if (answered) return <p role="status">Thank you. That helps us fix the right thing.</p>;
  return (
    <fieldset className="exit-poll">
      <legend>Not trying UAIN today? What stopped you?</legend>
      <p>One click, anonymous. We only count how often each answer is chosen.</p>
      <div className="exit-poll__choices">
        {choices.map(([stage, label]) => (
          <button key={stage} type="button" className="button exit-poll__choice"
            onClick={() => { countStage(stage); setAnswered(true); }}>
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
