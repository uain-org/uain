/**
 * Sign-ups per day and in total, as two inline SVG charts: one measure each,
 * one axis each. Hovering a day shows its numbers (an SVG <title>, so no
 * script is needed), and the same numbers are in a table under the charts.
 */
import { html } from './html.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86400000;
/** The charts show at most this many days, the most recent. */
const MAX_DAYS = 730;

const W = 620;
const H = 230;
const M = { top: 14, right: 18, bottom: 30, left: 46 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

const shortDay = (day) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
const longDay = (day) => `${shortDay(day)} ${day.slice(0, 4)}`;
const round = (x) => Math.round(x * 10) / 10;

/** A round top for the axis, and a step that divides it into about four. */
function scale(max) {
  if (max <= 0) return { top: 1, step: 1 };
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough));
  return { top: Math.ceil(max / step) * step, step };
}

/**
 * Days from the first sign-up to today, gaps filled with zero, and a running
 * total. Rows with an unreadable date are counted apart, not guessed at.
 */
export function daySeries(perDay, today) {
  const counts = new Map();
  let unreadable = 0;
  for (const { day, n } of perDay) {
    if (typeof day === 'string' && DAY.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)))
      counts.set(day, (counts.get(day) ?? 0) + n);
    else unreadable += n;
  }
  const known = [...counts.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!known.length) return { days: [], unreadable, before: 0 };
  const last = known.at(-1) > today ? known.at(-1) : today;
  const end = Date.parse(`${last}T00:00:00Z`);
  const start = Math.max(Date.parse(`${known[0]}T00:00:00Z`), end - (MAX_DAYS - 1) * MS_PER_DAY);
  const first = new Date(start).toISOString().slice(0, 10);
  let before = 0;
  for (const [day, n] of counts) if (day < first) before += n;
  const days = [];
  let total = before;
  for (let t = start; t <= end; t += MS_PER_DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    const n = counts.get(day) ?? 0;
    total += n;
    days.push({ day, n, total });
  }
  return { days, unreadable, before };
}

function frame(id, label, top, step, days) {
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const slot = PW / days.length;
  const every = Math.max(1, Math.ceil(days.length / 8));
  const xLabels = [];
  // Counted back from the last day, so today always has its label.
  for (let i = days.length - 1; i >= 0; i -= every) xLabels.push(i);
  return {
    slot,
    grid: html`${ticks.map((v) => {
      const y = round(M.top + PH - (v / top) * PH);
      return html`<line class="grid" x1="${M.left}" x2="${W - M.right}" y1="${y}" y2="${y}"></line>
        <text class="tick" x="${M.left - 8}" y="${y + 4}" text-anchor="end">${v.toLocaleString('en-GB')}</text>`;
    })}
    ${xLabels.map(
      (i) =>
        html`<text class="tick" x="${round(M.left + slot * (i + 0.5))}" y="${H - 8}" text-anchor="middle">${shortDay(days[i].day)}</text>`,
    )}
    <line class="axis" x1="${M.left}" x2="${W - M.right}" y1="${M.top + PH}" y2="${M.top + PH}"></line>`,
    open: html`<svg id="${id}" class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">`,
  };
}

function hits(days, slot, text) {
  return days.map(
    (d, i) =>
      html`<rect class="hit" x="${round(M.left + slot * i)}" y="${M.top}" width="${round(slot)}" height="${PH}"><title>${text(d)}</title></rect>`,
  );
}

export function perDayChart(days) {
  const { top, step } = scale(Math.max(...days.map((d) => d.n)));
  const f = frame('chart-daily', 'Sign-ups per day', top, step, days);
  const gap = f.slot > 6 ? 2 : f.slot > 3 ? 1 : 0;
  const w = Math.max(0.5, f.slot - gap);
  const bars = days.map((d, i) => {
    if (!d.n) return '';
    const h = (d.n / top) * PH;
    const x = M.left + f.slot * i + gap / 2;
    const y = M.top + PH - h;
    const r = Math.min(2, w / 2, h);
    // Square at the baseline, rounded at the value end.
    return html`<path class="bar" d="M${round(x)},${round(y + h)}V${round(y + r)}Q${round(x)},${round(y)} ${round(x + r)},${round(y)}H${round(x + w - r)}Q${round(x + w)},${round(y)} ${round(x + w)},${round(y + r)}V${round(y + h)}Z"></path>`;
  });
  return html`${f.open}${f.grid}${bars}${hits(days, f.slot, (d) => `${longDay(d.day)}: ${d.n.toLocaleString('en-GB')} sign-up${d.n === 1 ? '' : 's'}`)}</svg>`;
}

export function cumulativeChart(days) {
  const { top, step } = scale(days.at(-1).total);
  const f = frame('chart-total', 'Sign-ups in total', top, step, days);
  const pts = days.map((d, i) => [round(M.left + f.slot * (i + 0.5)), round(M.top + PH - (d.total / top) * PH)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');
  const base = M.top + PH;
  const area = `${line}L${pts.at(-1)[0]},${base}L${pts[0][0]},${base}Z`;
  const [lx, ly] = pts.at(-1);
  const end = days.at(-1).total.toLocaleString('en-GB');
  return html`${f.open}${f.grid}
    <path class="area" d="${area}"></path>
    <path class="line" d="${line}"></path>
    <circle class="dot" cx="${lx}" cy="${ly}" r="4.5"></circle>
    <text class="end" x="${lx - 10}" y="${Math.max(M.top + 12, ly - 10)}" text-anchor="end">${end}</text>
    ${hits(days, f.slot, (d) => `${longDay(d.day)}: ${d.total.toLocaleString('en-GB')} in total (+${d.n.toLocaleString('en-GB')})`)}</svg>`;
}

/** Both charts and the table behind them, or a line saying there is nothing yet. */
export function signupCharts(perDay, today) {
  const { days, unreadable, before } = daySeries(perDay, today);
  if (!days.length)
    return html`<p class="empty">No sign-ups with a readable date yet.</p>`;
  return html`<div class="grid2">
      <figure class="figure"><figcaption>Sign-ups per day</figcaption>${perDayChart(days)}</figure>
      <figure class="figure"><figcaption>Sign-ups in total</figcaption>${cumulativeChart(days)}</figure>
    </div>
    ${before ? html`<p class="note">The charts start at ${longDay(days[0].day)}; ${before.toLocaleString('en-GB')} earlier sign-ups are in the total.</p>` : ''}
    ${unreadable ? html`<p class="note">${unreadable === 1 ? '1 sign-up has' : `${unreadable.toLocaleString('en-GB')} sign-ups have`} an unreadable date and ${unreadable === 1 ? 'is' : 'are'} not in the charts.</p>` : ''}
    <details class="numbers"><summary>The numbers, day by day</summary>
      <table><thead><tr><th>Day</th><th class="num">Sign-ups</th><th class="num">In total</th></tr></thead>
      <tbody>${days
        .slice()
        .reverse()
        .map(
          (d) =>
            html`<tr><td>${longDay(d.day)}</td><td class="num">${d.n.toLocaleString('en-GB')}</td><td class="num">${d.total.toLocaleString('en-GB')}</td></tr>`,
        )}</tbody></table>
    </details>`;
}
