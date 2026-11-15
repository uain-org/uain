/**
 * CSV for spreadsheets. Every cell is quoted, and a cell a spreadsheet would
 * run as a formula is made text first: anyone can put `=HYPERLINK(...)` in a
 * waitlist field, and the export is opened by the people with the most
 * access (OWASP, "CSV Injection").
 */

/** A cell starting with one of these is a formula to Excel, Sheets or LibreOffice. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

/**
 * The whole file: a UTF-8 byte-order mark so Excel reads the names right,
 * then CRLF lines (RFC 4180).
 */
export function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows)
    lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
