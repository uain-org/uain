import { FAMILY_COLOUR, familyOf, hash01 } from '@/lib/network/globe-layers';
import {
  type Problem,
  type ProblemAgent,
  type Role,
  ROLES,
  stageColour,
} from './problems';

/**
 * The network view: the Earth steps back, and what is left is problems and the
 * AIs on them, as a web. A problem is a ring that fills as it is solved; an AI
 * is a dot, tied to every problem it is on. An AI on several problems is
 * pulled between them, so the ones doing the most end up in the middle.
 */

const ROLE_COLOUR: Record<Role, string> = {
  Understanding: '#6bc8ff',
  Planning: '#c9a7ff',
  'Finding resources': '#ffd84d',
  'Doing the work': '#ffb98a',
  Checking: '#3fe0a8',
};

interface Node {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  problem?: Problem;
  agent?: ProblemAgent;
  /** How many problems an AI is on. */
  degree: number;
}

interface Edge {
  a: Node;
  b: Node;
  role: Role;
  phase: number;
}

export type NetworkPick =
  | { kind: 'problem'; problem: Problem; x: number; y: number }
  | {
      kind: 'agent';
      agent: ProblemAgent;
      problems: Problem[];
      x: number;
      y: number;
    }
  | null;

export class NetworkView {
  onPick: (pick: NetworkPick) => void = () => {};

  private readonly ctx: CanvasRenderingContext2D;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private raf = 0;
  private running = false;
  private hover: Node | null = null;
  private selected: string | null = null;
  private key = '';
  /** The newest problems, kept so they can be laid out once there is room. */
  private latest: Problem[] = [];
  /** The canvas size the current layout was made for. */
  private laidOutFor = '';
  private readonly started = performance.now();
  private readonly reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  );
  private readonly off: (() => void)[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const at = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return this.near(e.clientX - r.left, e.clientY - r.top);
    };
    const move = (e: PointerEvent) => {
      this.hover = at(e);
      canvas.style.cursor = this.hover ? 'pointer' : 'default';
    };
    const click = (e: PointerEvent) => {
      const node = at(e);
      this.selected = node?.id ?? null;
      if (!node) return this.onPick(null);
      if (node.problem)
        this.onPick({
          kind: 'problem',
          problem: node.problem,
          x: node.x,
          y: node.y,
        });
      else if (node.agent)
        this.onPick({
          kind: 'agent',
          agent: node.agent,
          problems: this.edges
            .filter((l) => l.a === node)
            .map((l) => l.b.problem!)
            .filter(Boolean),
          x: node.x,
          y: node.y,
        });
    };
    const resized = () => {
      if (this.running) this.fit();
    };
    window.addEventListener('resize', resized);
    this.off.push(() => window.removeEventListener('resize', resized));
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('click', click as EventListener);
    this.off.push(
      () => canvas.removeEventListener('pointermove', move),
      () => canvas.removeEventListener('click', click as EventListener),
    );
  }

  private size() {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight };
  }

  /** The part of the screen the panels leave free. */
  private box() {
    const { w, h } = this.size();
    return {
      left: w > 760 ? 250 : 20,
      right: w >= 1500 ? w - 390 : w - 30,
      top: 150,
      bottom: h - 96,
    };
  }

  private near(x: number, y: number) {
    let best: Node | null = null;
    let d = 22;
    for (const n of this.nodes) {
      const r = Math.hypot(n.x - x, n.y - y) - (n.problem ? 16 : 0);
      if (r < d) {
        d = r;
        best = n;
      }
    }
    return best;
  }

  /** Problems keep their places between polls; only a new set is laid out again. */
  setProblems(problems: Problem[]) {
    this.latest = problems;
    // While the view is hidden the canvas has no size, and a layout made
    // then would pile everything into a corner. It waits for start().
    if (this.size().w === 0) return;
    const key = problems.map((p) => `${p.id}:${p.agents.length}`).join('|');
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    if (key === this.key) {
      for (const p of problems) {
        const n = byId.get(p.id);
        if (n) n.problem = p;
      }
      return;
    }
    this.key = key;
    const box = this.box();
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    const w = box.right - box.left;
    const h = box.bottom - box.top;
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const agents = new Map<string, Node>();
    // Two rings when there are many, so labels do not pile up.
    problems.forEach((p, i) => {
      const outer = problems.length <= 12 || i % 2 === 0;
      const angle = (i / problems.length) * Math.PI * 2 - Math.PI / 2;
      const rx = (outer ? 0.44 : 0.26) * w;
      const ry = (outer ? 0.42 : 0.22) * h;
      const old = byId.get(p.id);
      const node: Node = {
        id: p.id,
        x: old?.x ?? cx + Math.cos(angle) * rx,
        y: old?.y ?? cy + Math.sin(angle) * ry,
        vx: 0,
        vy: 0,
        problem: p,
        degree: 0,
      };
      nodes.push(node);
      for (const a of p.agents) {
        let an = agents.get(a.id);
        if (!an) {
          const prior = byId.get(a.id);
          an = {
            id: a.id,
            x: prior?.x ?? node.x + (hash01(a.id, 1) - 0.5) * 120,
            y: prior?.y ?? node.y + (hash01(a.id, 2) - 0.5) * 120,
            vx: 0,
            vy: 0,
            agent: a,
            degree: 0,
          };
          agents.set(a.id, an);
          nodes.push(an);
        }
        an.degree += 1;
        edges.push({
          a: an,
          b: node,
          role: a.role,
          phase: hash01(a.id + p.id, 3),
        });
      }
    });
    this.nodes = nodes;
    this.edges = edges;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.fit();
    const frame = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(frame);
      this.step();
      this.draw();
    };
    frame();
  }

  /** Match the canvas to its box, and lay out again if the box changed. */
  private fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { w, h } = this.size();
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const size = `${w}x${h}`;
    if (size !== this.laidOutFor) {
      this.laidOutFor = size;
      this.nodes = [];
      this.edges = [];
      this.key = '';
    }
    this.setProblems(this.latest);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  destroy() {
    this.stop();
    for (const fn of this.off) fn();
  }

  private step() {
    const box = this.box();
    const free = this.nodes.filter((n) => n.agent);
    for (const l of this.edges) {
      const dx = l.b.x - l.a.x;
      const dy = l.b.y - l.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const pull = (d - 78) * 0.012;
      l.a.vx += (dx / d) * pull;
      l.a.vy += (dy / d) * pull;
    }
    for (let i = 0; i < free.length; i += 1) {
      const a = free[i];
      for (const b of this.nodes) {
        if (a === b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy + 40;
        const reach = b.problem ? 2600 : 900;
        if (d2 > reach * 6) continue;
        const push = reach / d2 / 6;
        a.vx += dx * push * 0.06;
        a.vy += dy * push * 0.06;
      }
      a.vx *= 0.82;
      a.vy *= 0.82;
      a.x = Math.min(box.right, Math.max(box.left, a.x + a.vx));
      a.y = Math.min(box.bottom, Math.max(box.top - 30, a.y + a.vy));
    }
  }

  private draw() {
    const { ctx } = this;
    const { w, h } = this.size();
    const t = this.reducedMotion.matches
      ? 0
      : (performance.now() - this.started) / 1000;
    ctx.clearRect(0, 0, w, h);
    const focus =
      this.hover ?? this.nodes.find((n) => n.id === this.selected) ?? null;
    const lit = new Set<Node>();
    if (focus) {
      lit.add(focus);
      for (const l of this.edges) {
        if (l.a === focus) lit.add(l.b);
        if (l.b === focus) lit.add(l.a);
      }
    }
    const dim = (n: Node) => (focus && !lit.has(n) ? 0.18 : 1);
    // With many problems on screen only the gravest are named until asked.
    const crowded = this.nodes.length > 140;
    const loudest = new Set(
      this.nodes
        .filter((n) => n.problem)
        .sort((a, b) => b.problem!.severity - a.problem!.severity)
        .slice(0, 8)
        .map((n) => n.id),
    );

    for (const l of this.edges) {
      const on = !focus || l.a === focus || l.b === focus;
      ctx.globalAlpha = on ? 0.5 : 0.06;
      ctx.strokeStyle = ROLE_COLOUR[l.role];
      ctx.lineWidth = on && focus ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.b.x, l.b.y);
      ctx.stroke();
      // A pulse runs from the AI to the problem it is working on.
      if (on) {
        const u = (t * 0.35 + l.phase) % 1;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(
          l.a.x + (l.b.x - l.a.x) * u,
          l.a.y + (l.b.y - l.a.y) * u,
          1.6,
          0,
          7,
        );
        ctx.fill();
      }
    }

    for (const n of this.nodes) {
      ctx.globalAlpha = dim(n);
      if (n.agent) {
        const r = 3.5 + Math.min(4, n.degree);
        ctx.fillStyle = n.agent.real
          ? FAMILY_COLOUR[familyOf(n.agent.id)]
          : '#c9a7ff';
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, 7);
        ctx.fill();
        if (
          n === focus ||
          (lit.has(n) && focus) ||
          (!crowded && n.degree >= 3 && !focus)
        ) {
          ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
          ctx.fillStyle = 'rgba(232,240,244,0.92)';
          ctx.fillText(n.agent.name.slice(0, 24), n.x + r + 5, n.y + 3);
        }
        continue;
      }
      const p = n.problem!;
      const r = 15 + p.severity * 9;
      const tint = stageColour(p.stage);
      ctx.fillStyle = 'rgba(4,12,16,0.9)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 4, 0, 7);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 7);
      ctx.stroke();
      ctx.strokeStyle = tint;
      ctx.shadowColor = tint;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(
        n.x,
        n.y,
        r,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * Math.max(0.03, p.progress),
      );
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 11px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(p.aiCount), n.x, n.y + 4);
      if (!crowded || n === focus || lit.has(n) || loudest.has(p.id)) {
        ctx.font = '500 10.5px "JetBrains Mono", ui-monospace, monospace';
        ctx.fillStyle = 'rgba(232,240,244,0.94)';
        const words =
          p.title.length > 34 ? `${p.title.slice(0, 33)}…` : p.title;
        ctx.fillText(words, n.x, n.y + r + 18);
      }
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
  }

  /** The colours, for the legend. */
  static readonly roleColours = ROLES.map((r) => [r, ROLE_COLOUR[r]] as const);
}
