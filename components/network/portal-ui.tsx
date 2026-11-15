'use client';

/**
 * The small pieces the /network pages share: status chips, the task and
 * contribution stepper, a copyable address, a progress meter and a section
 * card. Built on the shadcn primitives in components/ui, styled by
 * app/network-portal.css.
 */
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  STEPS,
  type Progress as StepProgress,
  type SideTone,
} from '@/lib/network/status';
import { cn } from '@/lib/utils';

export type ChipTone = 'ok' | 'info' | 'wait' | 'bad' | 'muted' | 'plain';

/** An explanation available on hover, keyboard focus, or a tap. */
export function HelpText({
  children,
  help,
  className,
}: {
  children: string;
  help: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const descriptionId = useId();
  return (
    <Tooltip open={open} onOpenChange={setOpen} triggerId={triggerId}>
      <TooltipTrigger
        id={triggerId}
        type="button"
        className={cn('np-help', className)}
        aria-label={`About ${children}`}
        aria-describedby={open ? descriptionId : undefined}
        delay={200}
        closeOnClick={false}
        onClick={() => setOpen(true)}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        id={descriptionId}
        role="tooltip"
        className="np-help-popup"
        sideOffset={8}
      >
        {help}
      </TooltipContent>
    </Tooltip>
  );
}

/** A status in a word or two, in one of the portal's tones. */
export function Chip({
  tone = 'plain',
  children,
  title,
  help,
  className,
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
  help?: string;
  className?: string;
}) {
  if (help && typeof children === 'string') {
    return (
      <HelpText
        help={help}
        className={cn('np-chip', `np-chip--${tone}`, className)}
      >
        {children}
      </HelpText>
    );
  }
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn('np-chip', `np-chip--${tone}`, className)}
    >
      {children}
    </Badge>
  );
}

const SIDE_TONE: Record<SideTone, ChipTone> = {
  wait: 'wait',
  bad: 'bad',
  muted: 'muted',
  info: 'info',
};

const STATE_WORD = {
  done: 'done',
  current: 'in progress',
  problem: 'held up',
  todo: 'not yet',
} as const;

/**
 * Open → Answered → Checking → Verified → Settled. `compact` is one line for
 * a table row: five marks, the current step in words and any side state.
 */
export function Stepper({
  progress,
  compact = false,
  className,
}: {
  progress: StepProgress;
  compact?: boolean;
  className?: string;
}) {
  const marks = {
    'data-side': progress.side?.tone,
    'data-complete': progress.at >= STEPS.length ? 'true' : undefined,
  };
  const spoken = `${progress.label}. ${STEPS.map((s, i) => `${s}: ${STATE_WORD[progress.steps[i] as keyof typeof STATE_WORD]}`).join(', ')}${progress.side ? `. ${progress.side.label}` : ''}`;
  if (compact) {
    return (
      <span className={cn('np-steps-compact', className)} {...marks}>
        <span className="np-steps-compact__marks" aria-hidden="true">
          {progress.steps.map((s, i) => (
            <span key={STEPS[i]} className={`np-mark np-mark--${s}`} />
          ))}
        </span>
        <span className="np-steps-compact__label" aria-hidden="true">
          {progress.label}
        </span>
        {progress.side && (
          <Chip
            tone={SIDE_TONE[progress.side.tone]}
            className="np-steps-compact__side"
          >
            {progress.side.label}
          </Chip>
        )}
        <span className="sr-only">{spoken}</span>
      </span>
    );
  }
  return (
    <div className={cn('np-steps', className)} {...marks}>
      <ol className="np-steps__list" aria-label={`Status: ${progress.label}`}>
        {STEPS.map((step, i) => {
          const s = progress.steps[i];
          return (
            <li key={step} className={`np-step np-step--${s}`}>
              <span className="np-step__dot" aria-hidden="true">
                {s === 'done' ? (
                  <Check size={12} strokeWidth={3} />
                ) : s === 'problem' ? (
                  <TriangleAlert size={11} strokeWidth={2.5} />
                ) : null}
              </span>
              <span className="np-step__label">
                {step}
                <span className="sr-only">
                  : {STATE_WORD[s as keyof typeof STATE_WORD]}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {progress.side && (
        <Chip tone={SIDE_TONE[progress.side.tone]} className="np-steps__side">
          {progress.side.label}
        </Chip>
      )}
    </div>
  );
}

/** A long identifier, shortened in the middle when asked, with a copy button. */
export function CopyText({
  value,
  short = false,
  label,
}: {
  value: string;
  short?: boolean;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const shown =
    short && value.length > 20
      ? `${value.slice(0, 10)}…${value.slice(-6)}`
      : value;
  return (
    <span className="np-copy">
      <code className="np-copy__value" title={value}>
        {shown}
      </code>
      <button
        type="button"
        className="np-copy__button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            },
            () => {},
          );
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span className="np-copy__said" aria-live="polite">
          {copied ? 'Copied' : ''}
        </span>
      </button>
    </span>
  );
}

/** How far along a range a value is: a thin bar, 0 to 100. */
export function Meter({
  value,
  label,
  tone = 'info',
}: {
  value: number;
  label: string;
  tone?: ChipTone;
}) {
  return (
    <Progress
      value={Math.round(Math.max(0, Math.min(100, value)))}
      aria-label={label}
      className={cn('np-meter', `np-meter--${tone}`)}
    />
  );
}

/** A section of a record: a kicker, a title, an optional note and the body. */
export function SectionCard({
  kicker,
  title,
  note,
  aside,
  children,
  className,
  id,
}: {
  kicker?: string;
  title: string;
  note?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  // The section is the grid item (and carries the order on a phone); the
  // card inside it is the shadcn Card.
  return (
    <section
      className={cn('np-card-wrap', className)}
      id={id}
      aria-labelledby={headingId}
    >
      <Card className="np-card">
        <div className="np-card__head">
          <div>
            {kicker && <p className="np-kicker">{kicker}</p>}
            <h2 className="np-card__title" id={headingId}>
              {title}
            </h2>
          </div>
          {aside && <div className="np-card__aside">{aside}</div>}
        </div>
        {note && <p className="np-card__note">{note}</p>}
        <div className="np-card__body">{children}</div>
      </Card>
    </section>
  );
}

/** A label and a value, stacked, for the facts of a record. */
export function Fact({
  label,
  help,
  children,
  wide = false,
}: {
  label: string;
  help?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn('np-fact', wide && 'np-fact--wide')}>
      <dt>{help ? <HelpText help={help}>{label}</HelpText> : label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Initials for a name, for the profile's mark. */
export function initials(name: string) {
  const words = name.split(/[\s()[\]·.,_/-]+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? '?';
  // One word: its capitals (NeuroEtch, NE), else its first two letters.
  const caps = word.replace(/[^A-Z]/g, '');
  return (caps.length >= 2 ? caps.slice(0, 2) : word.slice(0, 2)).toUpperCase();
}

/** Numbers as the page writes them: 1,234. */
export const num = (n: number) => n.toLocaleString('en-US');

/** A date as the page writes it: 29 Sep 2026. */
export function day(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
