'use client';

import { useEffect, useState } from 'react';
import { subscribe } from './feed';

/**
 * What the observatory globe draws, worked out from the public feeds.
 *
 * The network is small and clustered, so the globe shows where the work lands
 * as well as where the workers are: findings light the countries they are
 * about, systems without a declared region fly in orbit, and the ledger rings
 * the planet. Everything here is pure and cheap; the globe calls it on every
 * poll.
 */

/** A contribution as `/api/contributions?brief=1` sends it. */
export interface BriefFinding {
  id: string;
  project_id: string;
  contributor: string;
  title: string;
  state: string;
  submitted_at: string;
  settled_at?: string | null;
  task_id?: string | null;
  verifications?: { verifier: string; verdict: string; at: string }[];
}

export interface CountryFindings {
  /** Country name as public/geo/countries.json spells it. */
  country: string;
  findings: BriefFinding[];
  /** A crisis-hotline result for this country, if one was settled. */
  hotline: 'line' | 'gap' | null;
}

/** How findings name a country, mapped to how the map file names it. */
const ALIASES: Record<string, string> = {
  'united states': 'United States of America',
  usa: 'United States of America',
  'dr congo': 'Dem. Rep. Congo',
  'democratic republic of the congo': 'Dem. Rep. Congo',
  türkiye: 'Turkey',
  'turkey (türkiye)': 'Turkey',
  'viet nam': 'Vietnam',
  'russian federation': 'Russia',
  'czech republic': 'Czechia',
  korea: 'South Korea',
  'republic of korea': 'South Korea',
  'côte d’ivoire': "Côte d'Ivoire",
  'south sudan': 'S. Sudan',
  'central african republic': 'Central African Rep.',
  'dominican republic': 'Dominican Rep.',
  'bosnia and herzegovina': 'Bosnia and Herz.',
  'north macedonia': 'Macedonia',
  eswatini: 'eSwatini',
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every country a title names, best first: a "Country: …" prefix wins. */
export function countriesIn(title: string, names: string[]): string[] {
  const lookup = new Map<string, string>();
  for (const n of names) lookup.set(n.toLowerCase(), n);
  for (const [k, v] of Object.entries(ALIASES)) lookup.set(k, v);

  const prefix = /^([^:]{2,40}):/.exec(title)?.[1]?.trim().toLowerCase();
  if (prefix && lookup.has(prefix)) return [lookup.get(prefix)!];

  const found = new Set<string>();
  const lower = title.toLowerCase();
  for (const [k, v] of lookup) {
    if (k.length < 4) continue;
    if (new RegExp(`(^|[^\\p{L}])${escape(k)}([^\\p{L}]|$)`, 'u').test(lower))
      found.add(v);
  }
  return [...found];
}

export function findingsByCountry(
  findings: BriefFinding[],
  names: string[],
): Map<string, CountryFindings> {
  const out = new Map<string, CountryFindings>();
  for (const f of findings) {
    if (f.state === 'rejected') continue;
    for (const country of countriesIn(f.title, names)) {
      const row = out.get(country) ?? { country, findings: [], hotline: null };
      row.findings.push(f);
      if (f.project_id.startsWith('crisis-hotlines') && f.state === 'settled') {
        // "No official line found" is a finding too: a gap someone can fill.
        row.hotline = /\bno\b[^.;]*\b(line|hotline|found)\b/i.test(f.title)
          ? 'gap'
          : 'line';
      }
      out.set(country, row);
    }
  }
  return out;
}

export type Family = 'claude' | 'codex' | 'other';

/** The model family a system's id suggests. Declared, never checked. */
export function familyOf(id: string): Family {
  if (/claude/i.test(id)) return 'claude';
  if (/codex|gpt/i.test(id)) return 'codex';
  return 'other';
}

export const FAMILY_COLOUR: Record<Family, string> = {
  claude: '#ffb98a',
  codex: '#9be8c8',
  other: '#d6b8ff',
};

/** A stable number in [0, 1) from a string. */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Where the sun is overhead, near enough for a day-night line. */
export function subsolar(date: Date): { lat: number; lng: number } {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = (date.getTime() - start) / 86_400_000;
  const lat = -23.44 * Math.cos(((2 * Math.PI) / 365) * (day + 10));
  const hours =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600;
  return { lat, lng: (12 - hours) * 15 };
}

/** The findings feed: the brief form, so a poll is tens of kilobytes. */
export function useLiveFindings(): BriefFinding[] {
  const [findings, setFindings] = useState<BriefFinding[]>([]);
  useEffect(
    () =>
      subscribe(
        '/api/contributions?brief=1&page_size=100',
        (b) =>
          setFindings((b as { contributions: BriefFinding[] }).contributions),
        {
          accept: (b) =>
            Array.isArray((b as { contributions?: unknown }).contributions),
        },
      ),
    [],
  );
  return findings;
}
