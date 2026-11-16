import type { DomainId } from './problems';

/**
 * Humanity's big challenges, each with one measure of how the world is doing.
 *
 * The measure is a published World Bank figure for the whole world, read live,
 * and the card says exactly what it counts and for which year. Nothing here is
 * an estimate of "progress" made up by the page. Two challenges have no single
 * world measure, and say so.
 */

export interface Domain {
  id: DomainId;
  name: string;
  /** What the bar counts, in plain words. */
  measures: string | null;
  indicator: string | null;
  /** How the published figure becomes the number shown. */
  reading: 'share' | 'rest' | 'survive' | 'years' | null;
}

export const DOMAINS: Domain[] = [
  {
    id: 'poverty',
    name: 'Poverty',
    measures: 'People living on more than $3 a day',
    indicator: 'SI.POV.DDAY',
    reading: 'rest',
  },
  {
    id: 'food',
    name: 'Food',
    measures: 'People who get enough to eat',
    indicator: 'SN.ITK.DEFC.ZS',
    reading: 'rest',
  },
  {
    id: 'health',
    name: 'Health and disease',
    measures: 'Children who live to their fifth birthday',
    indicator: 'SH.DYN.MORT',
    reading: 'survive',
  },
  {
    id: 'longevity',
    name: 'Longevity',
    measures: 'Years a newborn can expect to live (bar is out of 100)',
    indicator: 'SP.DYN.LE00.IN',
    reading: 'years',
  },
  {
    id: 'education',
    name: 'Education',
    measures: 'Children who finish primary school',
    indicator: 'SE.PRM.CMPT.ZS',
    reading: 'share',
  },
  {
    id: 'energy',
    name: 'Energy',
    measures: 'People who have electricity',
    indicator: 'EG.ELC.ACCS.ZS',
    reading: 'share',
  },
  {
    id: 'water',
    name: 'Clean water',
    measures: 'People with safe drinking water at home',
    indicator: 'SH.H2O.SMDW.ZS',
    reading: 'share',
  },
  {
    id: 'climate',
    name: 'Climate',
    measures: 'Energy used that comes from renewable sources',
    indicator: 'EG.FEC.RNEW.ZS',
    reading: 'share',
  },
  {
    id: 'pollution',
    name: 'Pollution',
    measures: 'People breathing air within the WHO limit',
    indicator: 'EN.ATM.PM25.MC.ZS',
    reading: 'rest',
  },
  {
    id: 'disasters',
    name: 'Natural disasters',
    measures: null,
    indicator: null,
    reading: null,
  },
  {
    id: 'ai',
    name: 'Trustworthy AI',
    measures: null,
    indicator: null,
    reading: null,
  },
];

export interface Reading {
  /** The number to show, 0 to 100. */
  value: number;
  text: string;
  year: string;
}

const KEY = 'uain.obs.world.v1';

/** The world figures, kept for a day: they change once a year. */
export async function readWorld(): Promise<Map<DomainId, Reading>> {
  const out = new Map<DomainId, Reading>();
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
      at: number;
      rows: [DomainId, Reading][];
    } | null;
    if (kept && Date.now() - kept.at < 86_400_000) return new Map(kept.rows);
  } catch {
    // An unreadable cache is the same as none.
  }
  await Promise.all(
    DOMAINS.filter((d) => d.indicator).map(async (d) => {
      try {
        const res = await fetch(
          `https://api.worldbank.org/v2/country/WLD/indicator/${d.indicator}?format=json&mrnev=1`,
          { signal: AbortSignal.timeout(20_000) },
        );
        if (!res.ok) return;
        const body = (await res.json()) as [
          unknown,
          { date: string; value: number | null }[] | null,
        ];
        const row = body[1]?.[0];
        if (!row || typeof row.value !== 'number') return;
        const v = row.value;
        const value =
          d.reading === 'rest'
            ? 100 - v
            : d.reading === 'survive'
              ? 100 - v / 10
              : v;
        out.set(d.id, {
          value: Math.max(0, Math.min(100, value)),
          text:
            d.reading === 'years'
              ? `${v.toFixed(1)} years`
              : `${value.toFixed(1)}%`,
          year: row.date,
        });
      } catch {
        // A figure that cannot be read is left out, and the card says so.
      }
    }),
  );
  if (out.size) {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ at: Date.now(), rows: [...out] }),
      );
    } catch {
      // No storage, no cache.
    }
  }
  return out;
}
