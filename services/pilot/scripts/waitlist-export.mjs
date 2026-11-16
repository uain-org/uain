/**
 * Prints every waitlist registration, contacts included, as JSON (or CSV with
 * --csv). The API never serves contacts, so this is the only way to read them.
 * CSV formula-like fields receive a leading apostrophe for spreadsheet use.
 * Use JSON when exact original field text is required.
 *
 * On the server:
 *   docker compose exec pilot node scripts/waitlist-export.mjs > waitlist.json
 *   docker compose exec pilot node scripts/waitlist-export.mjs --csv > waitlist.csv
 */
import { close } from '../dist/src/storage/store.js';
import { exportAll } from '../dist/src/api/waitlist.js';

const rows = await exportAll();
if (!process.argv.includes('--csv')) {
  console.log(JSON.stringify(rows, null, 2));
} else if (rows.length) {
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    let s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
    // CSV quoting does not stop spreadsheet formulas. Make dangerous prefixes
    // text, including formulas hidden behind whitespace/control characters.
    if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/u.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  console.log(cols.map(cell).join(','));
  for (const r of rows) console.log(cols.map((c) => cell(r[c])).join(','));
}
// The open database connection would otherwise keep the process running.
await close();
