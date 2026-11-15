import type { ReactNode } from 'react';

/*
 * Enough Markdown to show the site's own guides as pages (10 November 2026):
 * headings, paragraphs, fenced code, bullet lists, inline code, bold and
 * links. Rendered at build time from files in public/, which the team writes;
 * it is not a general Markdown parser and never sees visitor input.
 */

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)<>]+[^\s)<>.,;:])/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > at) out.push(text.slice(at, index));
    const id = `${key}-${n++}`;
    if (token.startsWith('`')) out.push(<code key={id}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) out.push(<strong key={id}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('[')) {
      const [, label, href] = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/) ?? [];
      out.push(
        <a key={id} href={href}>
          {label}
        </a>,
      );
    } else
      out.push(
        <a key={id} href={token}>
          {token}
        </a>,
      );
    at = index + token.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** The blocks of a Markdown file as React nodes; the first `# ` heading is returned apart. */
export function renderMarkdown(source: string): { title: string; body: ReactNode[] } {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const body: ReactNode[] = [];
  let title = '';
  let paragraph: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      const key = `p${body.length}`;
      body.push(<p key={key}>{inline(paragraph.join(' '), key)}</p>);
      paragraph = [];
    }
    if (list.length) {
      const key = `l${body.length}`;
      body.push(
        <ul key={key}>
          {list.map((item, i) => (
            <li key={i}>{inline(item, `${key}-${i}`)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      body.push(
        <pre className="access-code" key={`c${body.length}`}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flush();
      if (heading[1] === '#' && !title) title = heading[2];
      else {
        const text = heading[2];
        const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const key = `h${body.length}`;
        body.push(
          heading[1] === '###' ? (
            <h3 key={key} id={id}>
              {inline(text, key)}
            </h3>
          ) : (
            <h2 key={key} id={id}>
              {inline(text, key)}
            </h2>
          ),
        );
      }
      continue;
    }
    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) {
      if (paragraph.length) flush();
      list.push(item[1]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list.length && /^\s+\S/.test(line)) {
      list[list.length - 1] += ' ' + line.trim();
      continue;
    }
    if (list.length) flush();
    paragraph.push(line.trim());
  }
  flush();
  return { title, body };
}
