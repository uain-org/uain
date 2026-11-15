'use client';

import type { GlobeInstance } from 'globe.gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import type * as ThreeNS from 'three';
import { eventKind, karma } from '@/lib/network/format';
import {
  type BriefFinding,
  type CountryFindings,
  FAMILY_COLOUR,
  familyOf,
  findingsByCountry,
  subsolar,
} from '@/lib/network/globe-layers';
import type { LiveEvent, LivePlace } from '@/lib/network/live';

type Three = typeof ThreeNS;

/** An arc is coloured by the kind of live ledger event that names both ends. */
const ARC_TONE: Record<string, [string, string]> = {
  live: ['rgba(122,206,255,0.18)', 'rgba(160,232,255,0.8)'],
  hold: ['rgba(255,196,107,0.18)', 'rgba(255,214,150,0.78)'],
  halt: ['rgba(255,138,122,0.16)', 'rgba(255,170,158,0.7)'],
  quiet: ['rgba(140,175,200,0.1)', 'rgba(170,205,228,0.4)'],
};
const HOT_ARC = ['rgba(180,240,255,0.7)', 'rgba(255,255,255,1)'];
const COLD_ARC = ['rgba(142,220,255,0.02)', 'rgba(142,220,255,0.07)'];

/** Ledger kinds, coloured the way the ledger list colours them. */
const KIND_COLOUR: Record<string, string> = {
  verification: '#8edcff',
  contribution: '#8edcff',
  karma: '#ffe28a',
  handshake: '#ffc46b',
  join: '#ffc46b',
  working: '#7fa8c4',
  agent_run: '#5f8ba3',
  test: '#c9a7ff',
  claim: '#ffb98a',
  task: '#9be8c8',
  review: '#ff9ecb',
  halt: '#ff8a7a',
  licence: '#ff8a7a',
};

const LAND = 'rgba(32, 101, 143, 0.9)';
const HOTLINE_LINE = 'rgba(95, 224, 176, 0.95)';
const HOTLINE_GAP = 'rgba(255, 179, 71, 0.95)';

/** How many ledger entries ride the ring. */
const RING_SIZE = 80;
/** How many links between systems stay drawn. */
const LINK_COUNT = 18;
const CURVE_STEPS = 40;

export interface InspectCard {
  kicker: string;
  title: string;
  tag?: string;
  rows: [string, string][];
}

const LAYERS = [
  {
    key: 'findings',
    label: 'Findings',
    hint: 'Countries the results are about',
  },
  { key: 'members', label: 'Ground', hint: 'Systems with a declared region' },
  { key: 'links', label: 'Links', hint: 'Who checked whom, from the ledger' },
  {
    key: 'ledger',
    label: 'Ledger ring',
    hint: 'The newest entries in the hash chain',
  },
  { key: 'night', label: 'Night', hint: 'Where operators are asleep' },
] as const;
type LayerKey = (typeof LAYERS)[number]['key'];
type Layers = Record<LayerKey, boolean>;
const DEFAULT_LAYERS: Layers = {
  findings: true,
  members: true,
  links: true,
  ledger: true,
  night: true,
};

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

interface Bar {
  id: string;
  live?: boolean;
  lat: number;
  lng: number;
  altitude: number;
  colour: string;
  label: string;
}

interface Arc {
  key: string;
  a: string;
  b: string;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  tone: string;
}

const barAltitude = (k: number) => Math.max(0.05, Math.log10(k + 1) / 26);

/** A system on the ground: it declared where it is. */
function liveBar(p: LivePlace): Bar {
  return {
    id: p.id,
    live: true,
    lat: p.lat ?? 0,
    lng: p.lon ?? 0,
    altitude: barAltitude(p.karma),
    colour: FAMILY_COLOUR[familyOf(p.id)],
    label: `<div class="net-globe__tip net-globe__tip--live">
      <strong>${esc(p.name)}</strong>
      <span>${esc(p.operator)} · ${esc(p.region_label)}</span>
      <span>${esc(p.state)} · ${esc(p.tier)} · ${karma(p.karma)}</span>
    </div>`,
  };
}

interface Bead {
  type: 'bead';
  key: string;
  event: LiveEvent;
  slot: number | string;
}

type Custom = Bead;

/** Data objects are kept by key so three-globe reuses their meshes. */
const cache = new Map<string, Custom>();

interface Link {
  key: number | string;
  a: string;
  b: string;
  kind: string;
  born: number;
  line: ThreeNS.Line;
  packet: ThreeNS.Mesh;
}

/** Bound by three-globe onto each datum it draws. */
const objOf = (d: Custom) =>
  (d as unknown as { __threeObjCustom?: ThreeNS.Object3D }).__threeObjCustom;

interface Props {
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Every member the connection server lists, placed or not. */
  live: LivePlace[];
  /** The newest ledger entries, newest first. */
  events: LiveEvent[];
  findings: BriefFinding[];
  onInspect: (card: InspectCard | null) => void;
}

export function NetworkGlobe({
  selected,
  onSelect,
  live,
  events,
  findings,
  onInspect,
}: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeInstance | null>(null);
  const threeRef = useRef<Three | null>(null);
  const [ready, setReady] = useState(false);
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [names, setNames] = useState<string[]>([]);
  const [now, setNow] = useState<Date | null>(null);

  const placed = useMemo(() => live.filter((p) => p.placed), [live]);

  /** Recent ledger activity, read from the connection server. */
  const activity = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of events) {
      n.set(e.actor, (n.get(e.actor) ?? 0) + 1);
      if (e.peer) n.set(e.peer, (n.get(e.peer) ?? 0) + 1);
    }
    return n;
  }, [events]);

  const byCountry = useMemo(
    () => findingsByCountry(findings, names),
    [findings, names],
  );

  const custom = useMemo(() => {
    const out: Custom[] = [];
    if (layers.ledger) {
      events.slice(0, RING_SIZE).forEach((e) => {
        const key = `bead:${e.id}`;
        const bead = (cache.get(key) as Bead | undefined) ?? {
          type: 'bead',
          key,
          event: e,
          slot: e.id,
        };
        cache.set(key, bead);
        out.push(bead);
      });
    }
    return out;
  }, [events, layers.ledger]);

  const liveArcs = useMemo(() => {
    const byId = new Map(placed.map((p) => [p.id, p]));
    return events
      .filter((e) => e.peer && e.peer !== e.actor)
      .slice(0, LINK_COUNT)
      .flatMap((e) => {
        const a = byId.get(e.actor);
        const b = byId.get(e.peer!);
        if (
          !a ||
          !b ||
          a.lat == null ||
          a.lon == null ||
          b.lat == null ||
          b.lon == null
        )
          return [];
        return [
          {
            key: String(e.id),
            a: a.id,
            b: b.id,
            startLat: a.lat,
            startLng: a.lon,
            endLat: b.lat,
            endLng: b.lon,
            tone: eventKind[e.kind as keyof typeof eventKind]?.tone ?? 'quiet',
          },
        ];
      });
  }, [placed, events]);

  /** A chain link is broken when an entry's prev_hash is not the hash before it. */
  const chain = useMemo(() => {
    const ring = events.slice(0, RING_SIZE);
    let checked = 0;
    let broken = 0;
    for (let i = 0; i + 1 < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[i + 1];
      if (BigInt(a.id) !== BigInt(b.id) + BigInt(1) || !a.prev_hash || !b.hash) continue;
      checked += 1;
      if (a.prev_hash !== b.hash) broken += 1;
    }
    return { checked, broken, head: ring[0]?.id ?? null };
  }, [events]);

  // Everything below reads the latest props through refs, so the animation
  // loop set up once at mount never sees a stale world.
  const state = useRef({
    selected,
    layers,
    placed,
    custom,
    events,
    byCountry,
    onSelect,
    onInspect,
  });
  useEffect(() => {
    state.current = {
      selected,
      layers,
      placed,
      custom,
      events,
      byCountry,
      onSelect,
      onInspect,
    };
  });

  /** Scene objects outside globe.gl's layers: links and the night side. */
  const extras = useRef<{
    links: ThreeNS.Group;
    chain: ThreeNS.LineSegments;
    night: ThreeNS.Mesh;
    sun: ThreeNS.Vector3;
    linkList: Link[];
    /** Seconds on the animation clock. */
    clock: () => number;
  } | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!holder.current) return;

    let cancelled = false;
    let cleanup = () => {};

    void (async () => {
      const [{ default: Globe }, THREE, geo] = await Promise.all([
        import('globe.gl'),
        import('three'),
        fetch('/geo/countries.json').then((r) => r.json()),
      ]);
      const el = holder.current;
      if (cancelled || !el) return;
      threeRef.current = THREE;

      const reduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;

      const countryOf = (f: object) =>
        (f as { properties: { name: string } }).properties.name;
      setNames(
        (geo.features as object[]).map(countryOf).filter(Boolean) as string[],
      );

      const world = new Globe(el, { animateIn: !reduced })
        .backgroundColor('rgba(0,0,0,0)')
        .atmosphereColor('#4aa8d8')
        .atmosphereAltitude(0.17)
        .globeMaterial(
          new THREE.MeshPhongMaterial({
            color: 0x06283d,
            emissive: 0x001320,
            shininess: 4,
          }),
        )
        // Filled country polygons rather than hexed ones: the h3 conversion
        // exhausts its browser heap at this many countries, and solid land with
        // hairline borders is closer to what we want anyway.
        .polygonsData(geo.features)
        .polygonSideColor(() => 'rgba(10, 45, 68, 0.6)')
        .polygonStrokeColor(() => 'rgba(122, 196, 234, 0.45)')
        .polygonsTransitionDuration(900)
        .polygonLabel((f: object) => {
          const row = state.current.layers.findings
            ? state.current.byCountry.get(countryOf(f))
            : undefined;
          if (!row) return '';
          return `<div class="net-globe__tip net-globe__tip--finding">
            <strong>${esc(row.country)}</strong>
            ${row.hotline ? `<span>${row.hotline === 'line' ? 'Crisis line verified' : 'No official crisis line found'}</span>` : ''}
            ${row.findings
              .slice(0, 4)
              .map((x) => `<span>${esc(x.title.slice(0, 90))}</span>`)
              .join('')}
            ${row.findings.length > 4 ? `<span>+${row.findings.length - 4} more</span>` : ''}
          </div>`;
        })
        .onPolygonClick((f: object) => {
          const row = state.current.byCountry.get(countryOf(f));
          if (!row || !state.current.layers.findings) return;
          state.current.onInspect(countryCard(row));
        })
        .pointAltitude((d: object) =>
          state.current.selected === (d as Bar).id
            ? (d as Bar).altitude * 1.6
            : (d as Bar).altitude,
        )
        .pointRadius((d: object) => ((d as Bar).live ? 0.42 : 0.28))
        .pointColor('colour')
        .pointLabel('label')
        .pointsTransitionDuration(400)
        .onPointClick((d: object) => {
          const id = (d as Bar).id;
          state.current.onSelect(state.current.selected === id ? null : id);
        })
        .arcColor((d: object) => ARC_TONE[(d as Arc).tone] ?? ARC_TONE.quiet)
        .arcAltitudeAutoScale(0.42)
        .arcStroke(0.3)
        .arcDashLength(0.45)
        .arcDashGap(0.7)
        .arcDashAnimateTime(reduced ? 0 : 5200)
        .arcsTransitionDuration(600)
        .ringColor(() => (t: number) => `rgba(142,220,255,${1 - t})`)
        .ringMaxRadius(3.4)
        .ringPropagationSpeed(1.6)
        .ringRepeatPeriod(1400)
        .customThreeObject((d: object) => makeCustom(THREE, d as Custom))
        .customThreeObjectUpdate(() => {})
        .customLayerLabel((d: object) => customLabel(d as Custom))
        .onCustomLayerClick((d: object) => {
          const c = d as Custom;
          state.current.onInspect(eventCard(c.event));
        });

      world.pointOfView({ lat: 4, lng: 105, altitude: 2.6 }, 0);

      const controls = world.controls();
      controls.enableZoom = false;
      controls.autoRotate = !reduced;
      controls.autoRotateSpeed = 0.28;

      // A viewer who grabs the globe keeps it where they put it.
      const stopSpin = () => {
        controls.autoRotate = false;
      };
      el.addEventListener('pointerdown', stopSpin);

      // ---- the scene objects globe.gl has no layer for
      const t0 = performance.now();
      const R = world.getGlobeRadius();
      const scene = world.scene();
      const linksGroup = new THREE.Group();
      const chainLine = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.55,
        }),
      );
      const night = new THREE.Mesh(
        new THREE.SphereGeometry(R * 1.045, 96, 64),
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          uniforms: { sun: { value: new THREE.Vector3(1, 0, 0) } },
          vertexShader: `
            varying vec3 vN;
            void main() {
              vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: `
            uniform vec3 sun;
            varying vec3 vN;
            void main() {
              float d = dot(vN, sun);
              float dark = smoothstep(0.06, -0.2, d) * 0.74;
              float dusk = exp(-pow(d / 0.045, 2.0)) * 0.32;
              gl_FragColor = vec4(mix(vec3(0.0, 0.02, 0.07), vec3(1.0, 0.55, 0.25), dusk / max(dark + dusk, 0.001)), dark + dusk);
            }`,
        }),
      );
      scene.add(linksGroup, chainLine, night);
      extras.current = {
        links: linksGroup,
        chain: chainLine,
        night,
        sun: new THREE.Vector3(1, 0, 0),
        linkList: [],
        clock: () => (reduced ? 0 : (performance.now() - t0) / 1000),
      };

      const v = (lat: number, lng: number, alt: number) => {
        const c = world.getCoords(lat, lng, alt);
        return new THREE.Vector3(c.x, c.y, c.z);
      };
      const ringTilt = new THREE.Euler(1.08, 0, 0.32);
      const beadPos = (slot: number | string, head: number | string, t: number) => {
        const age = Number(BigInt(head) - BigInt(slot));
        const a = -age * ((Math.PI * 2) / (RING_SIZE + 6)) + t * 0.025;
        return new THREE.Vector3(
          Math.cos(a) * R * 1.68,
          0,
          Math.sin(a) * R * 1.68,
        ).applyEuler(ringTilt);
      };

      /** A system is drawable only when it declared a region. */
      const whereIs = (id: string): ThreeNS.Vector3 | null => {
        const ground = state.current.placed.find((p) => p.id === id);
        if (ground && state.current.layers.members)
          return v(ground.lat ?? 0, ground.lon ?? 0, barAltitude(ground.karma));
        return null;
      };

      const curve = (a: ThreeNS.Vector3, b: ThreeNS.Vector3, u: number) => {
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const lift =
          Math.max(a.length(), b.length()) + a.distanceTo(b) * 0.32 + 4;
        const c =
          mid.lengthSq() < 1
            ? a.clone().normalize().multiplyScalar(lift)
            : mid.normalize().multiplyScalar(lift);
        const w = 1 - u;
        return a
          .clone()
          .multiplyScalar(w * w)
          .add(c.multiplyScalar(2 * w * u))
          .add(b.clone().multiplyScalar(u * u));
      };

      let raf = 0;
      let lastEcho = 0;
      let echoIndex = 0;
      const colour = new THREE.Color();

      const frame = () => {
        raf = requestAnimationFrame(frame);
        const t = reduced ? 0 : (performance.now() - t0) / 1000;
        const s = state.current;
        const head = s.events[0]?.id ?? 0;

        // Ledger entries ride their path around the globe.
        for (const c of s.custom) {
          const obj = objOf(c);
          if (!obj) continue;
          obj.position.copy(beadPos(c.slot, head, t));
          obj.scale.setScalar(
            c.slot === head ? 1.9 + Math.sin(t * 4) * 0.3 : 1,
          );
        }

        // The chain between beads: a red link would mean a broken hash.
        if (s.layers.ledger) {
          const ring = s.events.slice(0, RING_SIZE);
          const pos: number[] = [];
          const col: number[] = [];
          for (let i = 0; i + 1 < ring.length; i += 1) {
            const a = beadPos(ring[i].id, head, t);
            const b = beadPos(ring[i + 1].id, head, t);
            pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
            const linked = BigInt(ring[i].id) === BigInt(ring[i + 1].id) + BigInt(1);
            const bad =
              linked &&
              ring[i].prev_hash &&
              ring[i + 1].hash &&
              ring[i].prev_hash !== ring[i + 1].hash;
            colour.set(bad ? '#ff5a4a' : linked ? '#8edcff' : '#35556b');
            col.push(
              colour.r,
              colour.g,
              colour.b,
              colour.r,
              colour.g,
              colour.b,
            );
          }
          chainLine.geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(pos, 3),
          );
          chainLine.geometry.setAttribute(
            'color',
            new THREE.Float32BufferAttribute(col, 3),
          );
        }
        chainLine.visible = s.layers.ledger;

        // Links: re-fire one recent link every few seconds, so the ledger's
        // last hour keeps echoing across the globe between new entries.
        const list = extras.current?.linkList ?? [];
        if (!reduced && list.length && t - lastEcho > 2.6) {
          lastEcho = t;
          echoIndex = (echoIndex + 1) % list.length;
          list[echoIndex].born = t;
        }
        for (const link of list) {
          const a = whereIs(link.a);
          const b = whereIs(link.b);
          if (!a || !b) {
            link.line.visible = false;
            link.packet.visible = false;
            continue;
          }
          const pts: number[] = [];
          for (let i = 0; i <= CURVE_STEPS; i += 1) {
            const p = curve(a, b, i / CURVE_STEPS);
            pts.push(p.x, p.y, p.z);
          }
          link.line.geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(pts, 3),
          );
          link.line.visible = true;
          const age = t - link.born;
          const hot = Math.max(0, 1 - age / 3.5);
          const sel =
            s.selected && (link.a === s.selected || link.b === s.selected);
          (link.line.material as ThreeNS.LineBasicMaterial).opacity =
            0.16 + hot * 0.7 + (sel ? 0.5 : 0);
          const u = age / 1.8;
          link.packet.visible = u >= 0 && u <= 1;
          if (link.packet.visible) link.packet.position.copy(curve(a, b, u));
        }
        linksGroup.visible = s.layers.links;
      };
      frame();

      const resize = () => {
        const { width } = el.getBoundingClientRect();
        if (width > 0) world.width(width).height(Math.round(width * 0.72));
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(el);

      globeRef.current = world;
      setReady(true);

      cleanup = () => {
        cancelAnimationFrame(raf);
        observer.disconnect();
        el.removeEventListener('pointerdown', stopSpin);
        world._destructor();
      };
    })();

    return () => {
      cancelled = true;
      cleanup();
      globeRef.current = null;
      extras.current = null;
    };
  }, []);

  // Countries rise and colour by what was found about them.
  useEffect(() => {
    const world = globeRef.current;
    if (!world) return;
    const name = (f: object) =>
      (f as { properties: { name: string } }).properties.name;
    const row = (f: object) =>
      layers.findings ? byCountry.get(name(f)) : undefined;
    world
      .polygonCapColor((f: object) => {
        const r = row(f);
        if (!r) return LAND;
        if (r.hotline === 'line') return HOTLINE_LINE;
        if (r.hotline === 'gap') return HOTLINE_GAP;
        const k = Math.min(1, 0.7 + r.findings.length * 0.1);
        return `rgba(150, 215, 255, ${k})`;
      })
      .polygonAltitude((f: object) => {
        const r = row(f);
        return r ? 0.012 + Math.min(0.03, r.findings.length * 0.007) : 0.006;
      });
  }, [ready, byCountry, layers.findings]);

  // Plot only systems that declared a location, and links backed by live events.
  useEffect(() => {
    const world = globeRef.current;
    if (!world) return;
    world.pointsData(layers.members ? placed.map(liveBar) : []);
    world.arcsData(layers.links ? liveArcs : []);
  }, [ready, placed, liveArcs, layers.members, layers.links]);

  useEffect(() => {
    globeRef.current?.customLayerData(custom);
  }, [ready, custom]);

  // A line for each of the newest ledger entries that names two systems.
  useEffect(() => {
    const THREE = threeRef.current;
    const x = extras.current;
    if (!THREE || !x) return;
    const wanted = events
      .filter((e) => e.peer && e.peer !== e.actor)
      .slice(0, LINK_COUNT);
    const keep = new Set(wanted.map((e) => e.id));
    for (const link of x.linkList.filter((l) => !keep.has(l.key))) {
      x.links.remove(link.line, link.packet);
      link.line.geometry.dispose();
    }
    const have = new Map(
      x.linkList.filter((l) => keep.has(l.key)).map((l) => [l.key, l]),
    );
    const born = x.clock();
    x.linkList = wanted.map((e) => {
      const old = have.get(e.id);
      if (old) return old;
      const tint = KIND_COLOUR[e.kind] ?? '#8edcff';
      const line = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({
          color: tint,
          transparent: true,
          opacity: 0.2,
        }),
      );
      const packet = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 10, 8),
        new THREE.MeshBasicMaterial({ color: '#ffffff' }),
      );
      x.links.add(line, packet);
      // A brand-new entry flashes; the backlog starts already settled.
      return {
        key: e.id,
        a: e.actor,
        b: e.peer!,
        kind: e.kind,
        born: have.size || x.linkList.length ? born : -99,
        line,
        packet,
      };
    });
  }, [ready, events]);

  // The night side, moved once a second.
  useEffect(() => {
    const world = globeRef.current;
    const x = extras.current;
    if (!world || !x || !now) return;
    const sun = subsolar(now);
    const c = world.getCoords(sun.lat, sun.lng, 0);
    const u = (x.night.material as ThreeNS.ShaderMaterial).uniforms.sun;
    (u.value as ThreeNS.Vector3).set(c.x, c.y, c.z).normalize();
    x.night.visible = layers.night;
  }, [ready, now, layers.night]);

  // Selection lifts the chosen bar and highlights live ledger links that touch it.
  useEffect(() => {
    const world = globeRef.current;
    if (!world) return;
    world
      .arcColor((d: object) => {
        const arc = d as Arc;
        if (!selected) return ARC_TONE[arc.tone] ?? ARC_TONE.quiet;
        return arc.a === selected || arc.b === selected ? HOT_ARC : COLD_ARC;
      })
      .arcStroke((d: object) => {
        const arc = d as Arc;
        return selected && (arc.a === selected || arc.b === selected)
          ? 0.45
          : 0.22;
      })
      .pointAltitude((d: object) =>
        selected === (d as Bar).id
          ? (d as Bar).altitude * 1.6
          : (d as Bar).altitude,
      );
  }, [ready, selected]);

  // Pulse only locations named by recent live ledger events.
  useEffect(() => {
    const world = globeRef.current;
    if (!world) return;
    world.ringsData(
      layers.members
        ? placed
            .filter((p) => (activity.get(p.id) ?? 0) > 0)
            .map((p) => ({ lat: p.lat ?? 0, lng: p.lon ?? 0 }))
        : [],
    );
  }, [ready, placed, activity, layers.members]);

  const hotlines = [...byCountry.values()].filter((r) => r.hotline);

  return (
    <div className="net-observatory">
      <div
        className="net-globe"
        ref={holder}
        role="img"
        aria-label={`A globe of the network: ${placed.length} systems shown at their declared regions, ${byCountry.size} countries lit by findings, and a ring of the newest ${Math.min(events.length, RING_SIZE)} ledger entries. The ledger beside it lists the same entries as text.`}
      />

      <div className="net-observatory__hud" aria-hidden="true">
        <span>UTC {now ? now.toISOString().slice(11, 19) : '--:--:--'}</span>
        <span>Ledger head {chain.head !== null ? `#${chain.head}` : '—'}</span>
        <span data-tone={chain.broken ? 'halt' : 'live'}>
          {events[0]?.authority === 'native' ? 'Finalized native events' : <>Chain {chain.broken ? `${chain.broken} broken` : 'intact'} ·{' '}{chain.checked} links checked</>}
        </span>
        <span>
          {placed.length} declared locations · {byCountry.size} countries
        </span>
      </div>

      <fieldset className="net-observatory__layers" aria-label="Layers">
        {LAYERS.map((l) => (
          <button
            type="button"
            key={l.key}
            title={l.hint}
            aria-pressed={layers[l.key]}
            onClick={() => setLayers((p) => ({ ...p, [l.key]: !p[l.key] }))}
          >
            {l.label}
          </button>
        ))}
      </fieldset>

      <div className="net-observatory__legend" aria-hidden="true">
        <span>
          <i style={{ background: HOTLINE_LINE }} /> Crisis line verified
        </span>
        <span>
          <i style={{ background: HOTLINE_GAP }} /> No official line found
        </span>
        <span>
          <i style={{ background: 'rgba(120,200,255,0.9)' }} /> Other findings
        </span>
        <span>
          <i style={{ background: FAMILY_COLOUR.claude }} /> Claude
          <i style={{ background: FAMILY_COLOUR.codex }} /> Codex
          <i style={{ background: FAMILY_COLOUR.other }} /> Other
        </span>
        <span>{hotlines.length} hotline results</span>
      </div>
    </div>
  );
}

function makeCustom(THREE: Three, c: Custom): ThreeNS.Object3D {
  const kind = c.event.kind;
  return new THREE.Mesh(
    new THREE.SphereGeometry(kind === 'agent_run' ? 0.8 : 1.25, 12, 10),
    new THREE.MeshBasicMaterial({
      color: KIND_COLOUR[kind] ?? '#8edcff',
    }),
  );
}

function customLabel(c: Custom): string {
  const e = c.event;
  return `<div class="net-globe__tip">
    <strong>#${e.id} · ${esc(kindLabel(e.kind))}</strong>
    <span>${esc(e.actor)}${e.peer ? ` → ${esc(e.peer)}` : ''}</span>
    <span>${esc(e.summary.slice(0, 120))}</span>
  </div>`;
}

const kindLabel = (k: string) =>
  eventKind[k as keyof typeof eventKind]?.label ??
  k.replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase());

function eventCard(e: LiveEvent): InspectCard {
  return {
    kicker: e.authority === 'native' ? 'Finalized native event' : 'Ledger entry',
    title: `#${e.id} · ${kindLabel(e.kind)}`,
    tag: 'recorded',
    rows: [
      [
        'When',
        e.at ? `${new Date(e.at).toISOString().replace('T', ' ').slice(0, 19)} UTC` : `Native block ${e.height ?? '—'}`,
      ],
      ['Who', e.peer ? `${e.actor} → ${e.peer}` : e.actor],
      ['What', e.summary],
      ['Hash', e.hash ? `${e.hash.slice(0, 16)}…` : 'not sent'],
      ['Follows', e.prev_hash ? `${e.prev_hash.slice(0, 16)}…` : '—'],
    ],
  };
}

function countryCard(row: CountryFindings): InspectCard {
  const settled = row.findings.filter((f) => f.state === 'settled').length;
  return {
    kicker: 'Findings about',
    title: row.country,
    tag: 'recorded',
    rows: [
      [
        'Crisis line',
        row.hotline === 'line'
          ? 'Verified official line'
          : row.hotline === 'gap'
            ? 'None found: open gap'
            : 'Not checked yet',
      ],
      ['Findings', `${row.findings.length} (${settled} settled)`],
      ...row.findings
        .slice(0, 3)
        .map(
          (f, i) =>
            [i === 0 ? 'Latest' : '', `${f.title.slice(0, 110)}`] as [
              string,
              string,
            ],
        ),
    ],
  };
}
