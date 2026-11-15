/**
 * HTML that escapes by default. Every value interpolated into an `html`
 * template is escaped unless it is itself the result of `html` (or `raw`,
 * used only for markup this app writes). Waitlist fields are written by
 * anyone on the internet, so nothing from the database is ever passed to
 * `raw`.
 */

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);

class Markup {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

/** Markup this app wrote itself. Never a value from a request or the database. */
export const raw = (text) => new Markup(String(text));

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Markup) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++)
    out += render(values[i]) + strings[i + 1];
  return new Markup(out);
}
