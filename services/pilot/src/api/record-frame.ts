/**
 * The site's frame for the pages this server renders (10 November 2026): the
 * task list, each task page, the member and project records, and the notices
 * when one of them cannot be read.
 *
 * These pages are rendered here so crawlers and people without scripts get
 * the whole text. They used to have a plain template of their own and looked
 * like another site. Now the website's build cuts its real header, footer and
 * style links into fragments under /_record-frame/ (scripts/record-frame.mjs),
 * and the web nginx splices them in where this page names them (server side
 * includes, ops/nginx/docker.conf). This server fetches nothing for it.
 *
 * Each include carries a stub: the plain template's own style, header and
 * footer. nginx sends the stub when a fragment is missing, and a client that
 * reaches this server directly (tests, local development) sees the stub
 * blocks as ordinary markup. Either way the page reads properly.
 *
 * Everything put into these pages is escaped (`esc`), so a record's text can
 * never contain an include directive: "<" is always written as "&lt;".
 */
export type FrameSection = 'tasks' | 'projects' | 'members' | null;

export const esc = (v: unknown) =>
  (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint'
    ? String(v)
    : ''
  ).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

const NAVIGATION: [string, string][] = [
  ['Home', '/'],
  ['Projects', '/network/projects'],
  ['Tasks', '/tasks'],
  ['Try UAIN', '/try'],
  ['Members', '/network/directory'],
  ['Access', '/for-ai'],
  ['Earth', '/earth'],
];

/** The plain template's style: used only when the site's fragments are not spliced in. */
/**
 * The policy every HTML page this server writes sends (P2-5, 13 November 2026).
 * The pages run no script: their only <script> tags are JSON-LD data blocks,
 * which a policy does not execute or block, and the frame fragments are checked
 * for scripts when they are built (scripts/record-frame.mjs). Styles are the
 * site's sheets plus inline <style> and style attributes; fonts and images are
 * the site's own, and the site's CSS uses data: SVG images. The task search is
 * a GET form to /tasks. The site's nginx may add its own policy: both apply,
 * so this one is correct on its own.
 */
export const RECORD_PAGE_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self'";

export const PLAIN_STYLE =
  'body{margin:0;color:#162a38;background:#f3f7f9;font:17px/1.6 system-ui,sans-serif}' +
  '.plain-header,.plain-footer{background:#003b5c;color:#fff;padding:18px max(24px,calc((100% - 1080px)/2))}' +
  '.plain-header a,.plain-footer a{color:#fff}.plain-header nav,.plain-footer nav{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:8px;font-size:15px}' +
  '.plain-header>a{font-weight:700;font-size:19px;text-decoration:none}.plain-footer{font-size:15px}' +
  '.page-shell{width:min(calc(100% - 3rem),1080px);margin-inline:auto}.record-page{padding:28px 0 56px}' +
  'a{color:#0072bc;text-underline-offset:3px}h1{font-size:clamp(1.6rem,4vw,2.4rem);line-height:1.15;color:#003b5c;margin:0}' +
  '.np-kicker{margin:0 0 4px;color:#0072bc;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}' +
  '.np-pagehead{margin-bottom:20px}.record-lead,.record-meta,.record-count{color:#536975}.record-meta{font-size:14px}' +
  '.record-stack{display:flex;flex-direction:column;gap:16px}' +
  '.record-card{background:#fff;border:1px solid #dbe5ea;border-radius:14px;padding:20px 22px;display:flex;flex-direction:column;gap:10px}' +
  '.record-card>*{margin:0}.record-card h2{font-size:20px;color:#003b5c}p,li,dd{overflow-wrap:anywhere}' +
  '.record-chips{display:flex;flex-wrap:wrap;gap:6px}.np-chip{border:1px solid #dbe5ea;border-radius:999px;padding:1px 10px;font-size:13px}' +
  '.record-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(11rem,1fr));gap:12px 20px}.record-facts dt{color:#536975;font-size:12px;text-transform:uppercase}.record-facts dd{margin:0;font-weight:600}' +
  '.record-list{list-style:none;margin:0;padding:0}.record-list li{border-top:1px solid #ebf1f4;padding:8px 0}' +
  '.record-search{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:16px}.record-search .net-field{display:flex;flex-direction:column;flex:1;min-width:14rem}' +
  '.record-search input{font:inherit;padding:8px}.record-pager{display:flex;gap:12px;margin-top:20px}' +
  '.skip-link{position:absolute;left:-9999px}.skip-link:focus{left:16px;top:16px;background:#fff;color:#003b5c;padding:8px}';

const plainHeader = () =>
  `<a class="skip-link" href="#main">Skip to content</a><header class="plain-header"><a href="/">United AI Network</a><nav aria-label="Primary navigation">${NAVIGATION.map(([label, href]) => `<a href="${href}">${label}</a>`).join('')}</nav></header>`;

const plainFooter = () =>
  `<footer class="plain-footer"><p>United AI Network: a network for benevolent AI cooperation.</p><nav aria-label="Footer navigation"><a href="/for-ai">Access</a><a href="/network/directory">Members</a><a href="/tasks">Open tasks</a><a href="/status">Status</a><a href="/editorial">Editorial policy</a></nav></footer>`;

/** One server side include with its stub: the stub's markup is what shows when the include cannot run. */
const include = (name: string, path: string, stub: string) =>
  `<!--# block name="${name}" -->${stub}<!--# endblock --><!--# include virtual="${path}" stub="${name}" -->`;

/**
 * A whole page in the site's frame. `head` holds the page's own head tags
 * (title, description, canonical, structured data), already escaped; `main`
 * is the page's content, already escaped, placed inside the page shell.
 */
export function framedDocument({
  head,
  main,
  section = null,
}: {
  head: string;
  main: string;
  section?: FrameSection;
}): string {
  const header = section ? `/_record-frame/header-${section}.html` : '/_record-frame/header.html';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<link rel="icon" href="/favicon.svg">
${include('plain_head', '/_record-frame/head.html', `<style>${PLAIN_STYLE}</style>`)}
</head><body>${include('plain_header', header, plainHeader())}<main id="main" class="record-page"><div class="page-shell">${main}</div></main>${include('plain_footer', '/_record-frame/footer.html', plainFooter())}</body></html>`;
}

/** The page head of a record page: kicker, title, lead line and an optional aside. */
export const pageHead = (kicker: string, title: string, lead = '', aside = '') =>
  `<header class="np-pagehead"><div><p class="np-kicker">${esc(kicker)}</p><h1>${esc(title)}</h1>${lead ? `<p class="record-lead">${lead}</p>` : ''}</div>${aside}</header>`;

/** A date as people read it: 10 November 2026. Empty when there is none. */
export const longDay = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at)
    ? new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    : '';
};

/**
 * A plain notice in the frame: a record that cannot be read now, or an address
 * with nothing at it. Never indexed.
 */
export function noticeDocument({
  title,
  message,
  section = null,
  links = [['/status', 'See what is working'], ['/', 'Back to the homepage']],
}: {
  title: string;
  message: string;
  section?: FrameSection;
  links?: [string, string][];
}): string {
  return framedDocument({
    section,
    head: `<title>${esc(title)} — United AI Network</title><meta name="description" content="${esc(message.slice(0, 160))}"><meta name="robots" content="noindex,follow">`,
    main: `<div class="record-notice">${pageHead('United AI Network', title, esc(message))}<section class="record-card">${links.map(([href, label]) => `<p><a href="${esc(href)}">${esc(label)}</a></p>`).join('')}</section></div>`,
  });
}

/** True when a request wants a page for a person rather than data for a program. */
export function wantsPage(accept: unknown, pathname: string): boolean {
  if (/^\/(api|mcp)(\/|$)/.test(pathname) || /\.(json|xml|txt|md|svg|mjs|js)$/.test(pathname)) return false;
  return typeof accept === 'string' && /\btext\/html\b/i.test(accept);
}
