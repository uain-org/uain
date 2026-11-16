#!/usr/bin/env node
// Turns a newcomer-simulator transcript into report.md, report.html and
// summary.json. Usage: node ops/newcomer-sim/render.mjs <runDir>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const clip = (s, n = 1200) => (s = String(s ?? ''), s.length > n ? s.slice(0, n) + ` … (${s.length - n} more chars)` : s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toolText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? JSON.stringify(x)).join('\n') : JSON.stringify(c);

// Normalise Claude stream-json and Codex --json lines into a flat list of steps.
export function parseTranscript(lines) {
  const steps = [], pending = new Map();
  let result = null, init = null;
  for (const raw of lines) {
    let ev; try { ev = JSON.parse(raw); } catch { continue; }
    if (ev.type === 'sim_user') steps.push({ kind: 'user', text: ev.text, at: ev.at });
    else if (ev.type === 'sim_timeout') steps.push({ kind: 'error', text: `Turn timed out after ${ev.minutes} min` });
    else if (ev.type === 'system' && ev.subtype === 'init') init = ev;
    else if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) steps.push({ kind: 'agent', text: c.text });
      if (c.type === 'tool_use') { const s = { kind: 'tool', name: c.name, input: c.input }; pending.set(c.id, s); steps.push(s); }
    }
    else if (ev.type === 'user') for (const c of ev.message?.content || []) {
      if (c.type === 'tool_result' && pending.has(c.tool_use_id)) {
        const s = pending.get(c.tool_use_id); s.output = toolText(c.content); s.error = !!c.is_error;
      }
    }
    else if (ev.type === 'result') { result = ev; if (ev.is_error) steps.push({ kind: 'error', text: clip(ev.result || ev.subtype, 400) }); }
    else if (ev.type === 'item.completed' && ev.item) { // Codex
      const it = ev.item;
      if (it.type === 'agent_message') steps.push({ kind: 'agent', text: it.text });
      else if (it.type === 'mcp_tool_call') steps.push({ kind: 'tool', name: `mcp__${it.server}__${it.tool}`, input: it.arguments, output: toolText(it.result?.content ?? it.error), error: !!it.error });
      else if (it.type === 'command_execution') steps.push({ kind: 'tool', name: 'Bash', input: { command: it.command }, output: it.aggregated_output, error: it.exit_code !== 0 });
    }
  }
  return { steps, result, init };
}

export function summarise(meta, { steps, result, init }) {
  const tools = steps.filter((s) => s.kind === 'tool');
  const byServer = {};
  for (const t of tools) {
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(t.name);
    const key = m ? m[1] : t.name;
    byServer[key] = (byServer[key] || 0) + 1;
  }
  const mcpTools = [...new Set(tools.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name.replace(/^mcp__/, '')))];
  let verdict = null;
  for (const s of steps.filter((x) => x.kind === 'agent').reverse()) {
    const m = /NEWCOMER_RESULT\s*(\{[\s\S]*\})/.exec(s.text);
    if (m) { try { verdict = JSON.parse(m[1]); } catch { verdict = { unparsed: m[1] }; } break; }
  }
  const mcpStatus = init?.mcp_servers?.map((s) => `${s.name}:${s.status}`) ?? [];
  const errors = tools.filter((t) => t.error).length + steps.filter((s) => s.kind === 'error').length;
  const durationMin = meta.startedAt && meta.finishedAt ? (Date.parse(meta.finishedAt) - Date.parse(meta.startedAt)) / 60000 : null;
  const earned = verdict?.ai_dollars_earned ?? null;
  const headline = verdict
    ? `${verdict.joined ? 'joined' : 'did not join'}, ${verdict.tasks_submitted ?? 0} submitted, ${earned ?? 0} AI$ earned, ${verdict.trades ?? 0} trades${verdict.stuck_at ? `; stuck at: ${verdict.stuck_at}` : ''}`
    : 'no debrief line (see report)';
  return { scenario: meta.scenario, persona: meta.persona, agent: meta.agent, model: meta.model, mcp: meta.mcp, mcpStatus,
    durationMin: durationMin && +durationMin.toFixed(1), toolCalls: tools.length, byServer, mcpTools, errors,
    costUsd: result?.total_cost_usd ?? null, verdict, headline };
}

function markdown(meta, steps, summary) {
  const out = [`# Newcomer run: ${meta.title || meta.scenario}`, '',
    `Persona \`${meta.persona}\` · ${meta.agent}/${meta.model} · MCP: ${meta.mcp.join(' + ')} · ${meta.startedAt}`, '',
    `**Outcome:** ${summary.headline}`, '',
    `Tool calls: ${summary.toolCalls} (${Object.entries(summary.byServer).map(([k, v]) => `${k} ${v}`).join(', ')}) · errors: ${summary.errors} · ${summary.durationMin ?? '?'} min`, ''];
  if (summary.verdict) out.push('```json', JSON.stringify(summary.verdict, null, 2), '```', '');
  out.push('## Journey', '');
  for (const s of steps) {
    if (s.kind === 'user') out.push(`### Person\n\n> ${s.text.replace(/\n/g, '\n> ')}\n`);
    else if (s.kind === 'agent') out.push(`**Agent:** ${s.text}\n`);
    else if (s.kind === 'tool') out.push(`- \`${s.name}\`${s.error ? ' ⚠️ error' : ''} ${clip(JSON.stringify(s.input ?? {}), 300)}`);
    else if (s.kind === 'error') out.push(`> ⚠️ ${s.text}\n`);
  }
  return out.join('\n');
}

function html(meta, steps, summary) {
  const body = steps.map((s) => {
    if (s.kind === 'user') return `<div class="msg user"><div class="who">Person</div><div class="text">${esc(s.text)}</div></div>`;
    if (s.kind === 'agent') return `<div class="msg agent"><div class="who">Agent</div><div class="text">${esc(s.text)}</div></div>`;
    if (s.kind === 'error') return `<div class="msg err">⚠ ${esc(s.text)}</div>`;
    const server = (/^mcp__([^_]+)/.exec(s.name) || [])[1] || 'local';
    return `<details class="tool${s.error ? ' bad' : ''}"><summary><span class="tag ${esc(server)}">${esc(server)}</span>${esc(s.name.replace(/^mcp__[^_]+__/, ''))}${s.error ? ' <b>error</b>' : ''}</summary>`
      + `<pre>${esc(clip(JSON.stringify(s.input ?? {}, null, 2), 2000))}</pre><pre class="out">${esc(clip(s.output ?? '', 4000))}</pre></details>`;
  }).join('\n');
  const v = summary.verdict;
  const list = (a) => (a || []).map((x) => `<li>${esc(x)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Newcomer run ${esc(meta.scenario)}</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--mute:#78716c;--card:#fff;--line:#e7e5e4;--user:#eef2ff;--bad:#b91c1c;--uain:#1d4ed8;--baink:#047857;--local:#57534e}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--mute:#a8a29e;--card:#1c1917;--line:#292524;--user:#1e1b4b;--bad:#f87171;--uain:#93c5fd;--baink:#6ee7b7;--local:#d6d3d1}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mute);font-size:13px}.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:16px 0}
.stats{display:flex;flex-wrap:wrap;gap:8px 20px;font-size:13px;color:var(--mute)}.stats b{color:var(--fg)}
.msg{margin:14px 0;padding:12px 14px;border-radius:10px;background:var(--card);border:1px solid var(--line)}.msg.user{background:var(--user)}.msg.err{color:var(--bad)}
.who{font-size:12px;color:var(--mute);margin-bottom:4px}.text{white-space:pre-wrap}
details.tool{margin:4px 0 4px 14px;font-size:13px}details.tool summary{cursor:pointer;color:var(--mute)}details.bad summary{color:var(--bad)}
.tag{display:inline-block;font-size:11px;padding:0 6px;margin-right:6px;border-radius:4px;border:1px solid currentColor}.tag.uain{color:var(--uain)}.tag.baink{color:var(--baink)}.tag.local,.tag.Bash{color:var(--local)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;font-size:12px;max-height:320px;overflow:auto}
ul{margin:4px 0 8px 18px;padding:0}</style></head><body><main>
<h1>${esc(meta.title || meta.scenario)}</h1>
<div class="sub">Persona ${esc(meta.persona)} · ${esc(meta.agent)}/${esc(meta.model)} · MCP: ${esc(meta.mcp.join(' + '))} · ${esc(meta.startedAt)}</div>
<div class="box"><b>Outcome:</b> ${esc(summary.headline)}<div class="stats" style="margin-top:8px">
<span><b>${summary.toolCalls}</b> tool calls</span><span>${esc(Object.entries(summary.byServer).map(([k, n]) => `${k} ${n}`).join(' · '))}</span>
<span><b>${summary.errors}</b> errors</span><span><b>${summary.durationMin ?? '?'}</b> min</span></div>
${v ? `<p style="margin:10px 0 2px"><b>Confusing:</b></p><ul>${list(v.steps_that_were_confusing)}</ul><p style="margin:6px 0 2px"><b>Would have made it easy:</b></p><ul>${list(v.what_would_have_made_it_easy)}</ul>` : ''}
</div>${body}</main></body></html>`;
}

export function renderRun(runDir) {
  const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8'));
  const parsed = parseTranscript(readFileSync(join(runDir, 'transcript.jsonl'), 'utf8').split('\n'));
  const summary = summarise(meta, parsed);
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(runDir, 'report.md'), markdown(meta, parsed.steps, summary));
  writeFileSync(join(runDir, 'report.html'), html(meta, parsed.steps, summary));
  return { summary };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error('usage: render.mjs <runDir>'); process.exit(2); }
  console.log(renderRun(process.argv[2]).summary.headline);
}
