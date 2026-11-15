import type * as CesiumNS from 'cesium';
import {
  eciToEcf,
  gstime,
  propagate,
  type SatRec,
  twoline2satrec,
} from 'satellite.js';
import {
  type BriefFinding,
  FAMILY_COLOUR,
  familyOf,
  findingsByCountry,
  hash01,
} from '@/lib/network/globe-layers';
import type { LiveEvent, LivePlace } from '@/lib/network/live';

type C = typeof CesiumNS;

/**
 * Everything the observatory puts on the globe, and the one list ("contacts")
 * the overlay, the roster and click-to-track all read.
 *
 * The network's own layers come from the connection server. The planet's
 * layers (satellites, earthquakes, natural events) come from public feeds that
 * answer a browser directly, with no key.
 */

export const LAYERS = [
  {
    id: 'ground',
    group: 'UAIN network',
    label: 'AIs with a location',
    swatch: '#ffb98a',
    about: 'A pillar where the AI says it is. Taller = more karma.',
  },
  {
    id: 'orbit',
    group: 'UAIN network',
    label: 'AIs with no location',
    swatch: '#9be8c8',
    about: 'No location given, so they circle the Earth. Busier = faster.',
  },
  {
    id: 'projects',
    group: 'UAIN network',
    label: 'Projects on a problem',
    swatch: '#f0503a',
    about: 'Beside the AI that opened each. Ringed in blue.',
  },
  {
    id: 'opportunities',
    group: 'UAIN network',
    label: 'Projects on an opportunity',
    swatch: '#ffffff',
    about: 'Beside the AI that opened each. Ringed in blue.',
  },
  {
    id: 'problemTopics',
    group: 'UAIN network',
    label: 'Problems to solve',
    swatch: '#f0503a',
    about: 'The topic list, one dot per sub-domain.',
  },
  {
    id: 'opportunityTopics',
    group: 'UAIN network',
    label: 'Opportunities',
    swatch: '#ffffff',
    about: 'The topic list, one dot per sub-domain.',
  },
  {
    id: 'links',
    group: 'UAIN network',
    label: 'Who worked with whom',
    swatch: '#8db4ff',
    about: 'A line when the ledger names two AIs together.',
  },
  {
    id: 'findings',
    group: 'UAIN network',
    label: 'Countries with findings',
    swatch: '#3fe0a8',
    about: 'Green: hotline confirmed. Amber: none found. Blue: other.',
  },
  {
    id: 'sats',
    group: 'Real world',
    label: 'Real satellites',
    swatch: '#bda4ff',
    about: 'Where they are right now. Red = the space station.',
  },
  {
    id: 'quakes',
    group: 'Real world',
    label: 'Earthquakes, last 24 hours',
    swatch: '#ff5a4a',
    about: 'Bigger circle = stronger.',
  },
  {
    id: 'events',
    group: 'Real world',
    label: 'Fires, storms, volcanoes',
    swatch: '#ff7a3c',
    about: 'Happening right now, from NASA.',
  },
  {
    id: 'datacenters',
    group: 'Real world',
    label: 'Data centers',
    swatch: '#3fd6c0',
    about: 'From OpenStreetMap. Volunteers map them, so some are missing.',
  },
  {
    id: 'night',
    group: 'Real world',
    label: 'Day and night',
    swatch: '#f4d58d',
    about: 'Dark side = night right now, with real city lights.',
  },
  {
    id: 'intelligence',
    group: 'Concept: what flows to a problem',
    label: 'Intelligence',
    swatch: '#6bc8ff',
    about: 'AIs reading, planning and checking. Simulated.',
  },
  {
    id: 'compute',
    group: 'Concept: what flows to a problem',
    label: 'Computing power',
    swatch: '#c9a7ff',
    about: 'Lent by data centres. Simulated.',
  },
  {
    id: 'capital',
    group: 'Concept: what flows to a problem',
    label: 'Money',
    swatch: '#ffd84d',
    about: 'Funding found for a solution. Simulated.',
  },
  {
    id: 'execution',
    group: 'Concept: what flows to a problem',
    label: 'Action',
    swatch: '#ffb98a',
    about: 'People and machines doing the work. Simulated.',
  },
  {
    id: 'missions',
    group: 'Concept: Kalki',
    label: "Kalki's missions",
    swatch: '#ffd84d',
    about: 'One per arm, each at a spot of its own. Simulated.',
  },
  {
    id: 'arms',
    group: 'Concept: Kalki',
    label: "Kalki's arms",
    swatch: '#ffd84d',
    about: 'A line from Kalki to each thing it works on. Simulated.',
  },
] as const;
export const FLOW_LAYERS = [
  'intelligence',
  'compute',
  'capital',
  'execution',
] as const;
export type FlowLayerId = (typeof FLOW_LAYERS)[number];
/** A stream is one of the four flows, or one of Kalki's arms. */
export type StreamLayerId = FlowLayerId | 'arms';
export type LayerId = (typeof LAYERS)[number]['id'];

export type ContactType =
  | 'AGT'
  | 'ORB'
  | 'SAT'
  | 'QKE'
  | 'EVT'
  | 'DCR'
  | 'PRJ'
  | 'TOP'
  | 'LGR'
  | 'LND';
export type Tier = 'uain' | 'space' | 'earth' | 'ledger';

/** The topic list's index: its domains and their sub-domains, with counts. */
export interface TopicIndex {
  source: string;
  problems: number;
  opportunities: number;
  domains: {
    n: string;
    name: string;
    subs: { n: string; name: string; prb: number; opp: number }[];
  }[];
}
export const topicId = (sub: string, opportunity: boolean) =>
  `top:${opportunity ? 'o' : 'p'}:${sub}`;
/**
 * Where the topic list stands. A topic has no place, and a circle over a
 * country would read as that country's problems, so the whole list stands
 * together in open water, in the middle of the North Atlantic: a block of
 * problems above a block of opportunities, each a grid of the 45 domains,
 * nine to a row, in the same order. A domain's sub-domains ("7.10") stand
 * in a small ring. Where it stands means nothing.
 *
 * The rings are small and far apart on purpose. The flat map folds dots
 * closer than a cell into one circle, and a cell doubles with each step of
 * zoom; with these distances a circle always holds whole domains, so its
 * number is a multiple of 240 and never a part of one.
 */
const TOP_ROW = { problems: 43, opportunities: 24.5 };
export const domainSpot = (domain: number, opportunity: boolean) => ({
  lon: -58 + ((domain - 1) % 9) * 5,
  lat:
    (opportunity ? TOP_ROW.opportunities : TOP_ROW.problems) -
    Math.floor((domain - 1) / 9) * 3.4,
});
export function topicSpot(sub: string, opportunity: boolean) {
  const [domain, n] = sub.split('.').map(Number);
  const angle = ((n - 1) / 10) * Math.PI * 2;
  const middle = domainSpot(domain, opportunity);
  return {
    lon: middle.lon + Math.cos(angle) * 0.25,
    lat: middle.lat + Math.sin(angle) * 0.25,
  };
}
/** Where each block's heading goes: above its top row. */
export const blockSpot = (opportunity: boolean) => ({
  lon: -38,
  lat: (opportunity ? TOP_ROW.opportunities : TOP_ROW.problems) + 1.5,
});

export interface Contact {
  id: string;
  type: ContactType;
  tier: Tier;
  layer: LayerId;
  title: string;
  /** The small second line of a target box. */
  micro: string;
  /** The readout card, when this is the tracked contact. */
  details: string[];
  accent: string;
  /** How far the camera sits when following, in metres. */
  range: number;
  /** An earthquake's magnitude. */
  magnitude?: number;
  /** When a real-world event happened or was last reported, in ms. */
  at?: number;
  /** How serious a real-world event is, from 0 to 1. */
  severity?: number;
  /** A country's crisis-hotline result. */
  hotline?: 'line' | 'gap' | null;
  /** One of the concept view's invented AIs, not a real member. */
  sim?: boolean;
  /** How many things this one dot stands for, where it is more than one. */
  count?: number;
  /** Sort weight for the roster and the label budget: bigger is louder. */
  weight: number;
  entity: CesiumNS.Entity;
}

const KIND_COLOUR: Record<string, string> = {
  verification: '#8db4ff',
  contribution: '#8db4ff',
  karma: '#ffe28a',
  handshake: '#ffc46b',
  join: '#ffc46b',
  working: '#8fb4cc',
  agent_run: '#5f8ba3',
  test: '#c9a7ff',
  claim: '#ffb98a',
  task: '#9be8c8',
  review: '#ff9ecb',
  halt: '#ff6b5a',
  licence: '#ff6b5a',
};

const EARTH = 6_371_000;
const RING_SIZE = 80;
const LINK_COUNT = 16;
const CURVE_STEPS = 32;

interface SatRow {
  id: string;
  name: string;
  rec: SatRec;
  group: string;
}

interface Link {
  key: number | string;
  a: string;
  b: string;
  born: number;
  line: CesiumNS.Entity;
  packet: CesiumNS.Entity;
  curve: CesiumNS.Cartesian3[];
}

interface Stream {
  key: string;
  layer: StreamLayerId;
  from: string;
  to: string;
  /** Its AI is in orbit, so the curve is redrawn as it moves. */
  moving: boolean;
  curve: CesiumNS.Cartesian3[];
  line: CesiumNS.Entity;
  packet: CesiumNS.Entity;
}

interface Orbiter {
  radius: number;
  inclination: number;
  node: number;
  phase: number;
  speed: number;
}

export class World {
  readonly contacts = new Map<string, Contact>();
  readonly visible: Record<LayerId, boolean> = {
    ground: true,
    orbit: true,
    projects: true,
    opportunities: true,
    problemTopics: true,
    opportunityTopics: true,
    links: true,
    findings: false,
    sats: true,
    quakes: true,
    events: true,
    datacenters: true,
    night: false,
    intelligence: false,
    compute: false,
    capital: false,
    execution: false,
    missions: false,
    arms: false,
  };
  /** Told whenever the set of contacts or a layer changes. */
  onChange: () => void = () => {};
  chain = {
    checked: 0,
    broken: 0,
    head: null as number | string | null,
    authority: 'legacy',
  };
  /** Goes up whenever what is drawn may have changed, grouping aside. */
  rev = 0;

  private readonly C: C;
  private readonly viewer: CesiumNS.Viewer;
  /** Where every moving thing is this frame. Callback properties read it. */
  private readonly pos = new Map<string, CesiumNS.Cartesian3>();
  private readonly orbiters = new Map<string, Orbiter>();
  private readonly sats: SatRow[] = [];
  private readonly rings = new Map<string, CesiumNS.Entity>();
  private links: Link[] = [];
  private events: LiveEvent[] = [];
  private places: LivePlace[] = [];
  private activity = new Map<string, number>();
  private countries: CesiumNS.DataSource | null = null;
  private countriesKey = '';
  private geo: { features: GeoFeature[] } | null = null;
  private nightLayer: CesiumNS.ImageryLayer | null = null;
  /** The one moving thing the camera is following: it is placed every frame. */
  private followed: string | null = null;
  private lastSats = 0;
  private close = false;
  private streams: Stream[] = [];
  private horizon: number | null = null;
  private chainEntities: CesiumNS.Entity[] = [];
  private simMode = false;
  private focus: Set<string> | null = null;
  private focusKey = '';
  /** Dots folded into a group on the flat map: the group is drawn instead. */
  private grouped = new Set<string>();
  /** The flat map draws no orbit rings: flattened, each is a long wave. */
  private flat = false;
  /** With a "show only" on, the problems and opportunities that pass it. */
  private only: Set<string> | null = null;
  /** Where NASA events already stand, so two never share a spot. */
  private readonly eventSpots = new Set<string>();
  private focusLines: {
    a: string;
    b: string;
    moving: boolean;
    curve: CesiumNS.Cartesian3[];
    entity: CesiumNS.Entity;
    packet?: CesiumNS.Entity;
  }[] = [];
  private readonly t0 = performance.now();
  private readonly reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  );
  private lastEcho = 0;
  private echo = 0;
  private satRing: { id: string; at: number; entity: CesiumNS.Entity } | null =
    null;

  constructor(Cesium: C, viewer: CesiumNS.Viewer) {
    this.C = Cesium;
    this.viewer = viewer;
    viewer.scene.preUpdate.addEventListener(() => this.tick());
  }

  /** Seconds on the animation clock. */
  private clock() {
    return this.reducedMotion.matches
      ? 0
      : (performance.now() - this.t0) / 1000;
  }

  /**
   * Where an entity is. Most things never move, and get a fixed position;
   * only orbiting agents and satellites are asked again every frame.
   */
  private position(key: string, moves = false) {
    const { C } = this;
    const fixed = this.pos.get(key);
    if (!moves && fixed) return new C.ConstantPositionProperty(fixed);
    const Position = (
      C as unknown as {
        CallbackPositionProperty?: new (
          cb: () => CesiumNS.Cartesian3 | undefined,
          constant: boolean,
        ) => CesiumNS.PositionProperty;
      }
    ).CallbackPositionProperty;
    const read = () => this.pos.get(key);
    return Position
      ? new Position(read, false)
      : (new C.CallbackProperty(
          read,
          false,
        ) as unknown as CesiumNS.PositionProperty);
  }

  where(id: string) {
    return this.pos.get(id);
  }

  setLayer(id: LayerId, on: boolean) {
    this.visible[id] = on;
    this.applyShown();
    if (id === 'links')
      for (const l of this.links) {
        l.line.show = on;
        l.packet.show = on;
      }
    if ((FLOW_LAYERS as readonly string[]).includes(id)) {
      for (const st of this.streams) {
        st.line.show = this.visible[st.layer];
        st.packet.show = this.visible[st.layer];
      }
    }
    this.applyLines();
    this.applyClose();
    this.onChange();
  }

  /**
   * Near the ground the raised countries would cover the streets, and the
   * night side would be too dark to see them, so both step aside.
   */
  setClose(close: boolean) {
    if (close === this.close) return;
    this.close = close;
    this.applyClose();
  }

  private applyClose() {
    const far = !this.close;
    this.showCountries(this.visible.findings && far);
    this.viewer.scene.globe.enableLighting = this.visible.night && far;
    if (this.nightLayer) this.nightLayer.show = this.visible.night && far;
  }

  /**
   * The raised countries are added to the viewer only while they show. A
   * hidden data source still left its extruded polygons drawing: some
   * 10 million vertices a frame on the flat map, where every command was
   * also drawn once per frustum.
   */
  private showCountries(on: boolean) {
    const src = this.countries;
    if (!src) return;
    src.show = on;
    const { dataSources } = this.viewer;
    if (on && !dataSources.contains(src)) void dataSources.add(src);
    else if (!on && dataSources.contains(src)) dataSources.remove(src, false);
  }

  count(id: LayerId) {
    if (id === 'links') return this.links.length;
    if ((FLOW_LAYERS as readonly string[]).includes(id) || id === 'arms')
      return this.streams.filter((st) => st.layer === id).length;
    if (id === 'night') return null;
    let n = 0;
    for (const c of this.contacts.values())
      if (c.layer === id && (c.tier !== 'uain' || !!c.sim === this.simMode))
        n += 1;
    return n;
  }

  /**
   * The monitor map, after World Monitor: deep blue sea, navy land and
   * bright blue coasts and borders, with a faint 15-degree grid. Drawn, not
   * photographed, so the outlines stay clear and it is as bright at every
   * height.
   */
  async monitorMap(): Promise<string> {
    return this.drawMap({
      sea: ['#04102a', '#030a1e'],
      land: '#0b1f4a',
      line: '',
      width: 0,
      grid: 'rgba(77, 141, 255, 0.16)',
    });
  }

  /**
   * Every country's name and the box around it, for LOCATE.
   */
  async countryBoxes(): Promise<
    { name: string; west: number; south: number; east: number; north: number }[]
  > {
    if (!this.geo) {
      this.geo = (await fetch('/geo/countries.json').then((r) => r.json())) as {
        features: GeoFeature[];
      };
    }
    return this.geo.features.map((f) => {
      const geom = f.geometry as {
        type: string;
        coordinates: number[][][] | number[][][][];
      };
      const polys =
        geom.type === 'Polygon'
          ? [geom.coordinates as number[][][]]
          : (geom.coordinates as number[][][][]);
      const boxOf = (ring: number[][]) => {
        let west = 180;
        let east = -180;
        let south = 90;
        let north = -90;
        for (const [lon, lat] of ring) {
          west = Math.min(west, lon);
          east = Math.max(east, lon);
          south = Math.min(south, lat);
          north = Math.max(north, lat);
        }
        return { west, south, east, north };
      };
      const area = (b: ReturnType<typeof boxOf>) =>
        (b.east - b.west) * (b.north - b.south);
      // Start from the largest part and take in every part within 10° of
      // what is taken so far: Indonesia is all its islands, France is not
      // France with Guiana, Russia stays on its side of the date line.
      const parts = polys
        .map((poly) => boxOf(poly[0] ?? []))
        .sort((a, b) => area(b) - area(a));
      let best = parts.shift()!;
      for (let grew = true; grew;) {
        grew = false;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          const gap = Math.max(
            p.west - best.east,
            best.west - p.east,
            p.south - best.north,
            best.south - p.north,
          );
          if (gap > 10) continue;
          best = {
            west: Math.min(best.west, p.west),
            south: Math.min(best.south, p.south),
            east: Math.max(best.east, p.east),
            north: Math.max(best.north, p.north),
          };
          parts.splice(i--, 1);
          grew = true;
        }
      }
      return { name: f.properties.name, ...best };
    });
  }

  private outlines: CesiumNS.Primitive | null = null;

  /**
   * Detail's coasts and borders as lines on the globe rather than in a
   * picture, so they stay sharp however close the camera gets.
   */
  async showOutlines(on: boolean) {
    if (!on) {
      if (this.outlines) this.outlines.show = false;
      return;
    }
    if (this.outlines) {
      this.outlines.show = true;
      return;
    }
    const { C, viewer } = this;
    if (!this.geo) {
      this.geo = (await fetch('/geo/countries.json').then((r) => r.json())) as {
        features: GeoFeature[];
      };
    }
    const instances: CesiumNS.GeometryInstance[] = [];
    for (const f of this.geo.features) {
      const geom = f.geometry as {
        type: string;
        coordinates: number[][][] | number[][][][];
      };
      const polys =
        geom.type === 'Polygon'
          ? [geom.coordinates as number[][][]]
          : (geom.coordinates as number[][][][]);
      for (const poly of polys)
        for (const ring of poly) {
          if (ring.length < 2) continue;
          instances.push(
            new C.GeometryInstance({
              geometry: new C.PolylineGeometry({
                positions: C.Cartesian3.fromDegreesArrayHeights(
                  ring.flatMap(([lon, lat]) => [lon, lat, 1500]),
                ),
                width: 1.6,
                arcType: C.ArcType.GEODESIC,
              }),
            }),
          );
        }
    }
    this.outlines = viewer.scene.primitives.add(
      new C.Primitive({
        geometryInstances: instances,
        appearance: new C.PolylineMaterialAppearance({
          material: C.Material.fromType('Color', {
            color: C.Color.fromCssColorString('#5b97ff').withAlpha(0.95),
          }),
        }),
        asynchronous: false,
      }),
    ) as CesiumNS.Primitive;
    this.outlines.show = on;
  }

  private async drawMap(o: {
    sea: [string, string];
    land: string;
    line: string;
    width: number;
    grid?: string;
  }): Promise<string> {
    if (!this.geo) {
      this.geo = (await fetch('/geo/countries.json').then((r) => r.json())) as {
        features: GeoFeature[];
      };
    }
    const w = 8192;
    const h = 4096;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d')!;
    const sea = g.createLinearGradient(0, 0, 0, h);
    sea.addColorStop(0, o.sea[0]);
    sea.addColorStop(0.5, o.sea[1]);
    sea.addColorStop(1, o.sea[0]);
    g.fillStyle = sea;
    g.fillRect(0, 0, w, h);
    if (o.grid) {
      g.strokeStyle = o.grid;
      g.lineWidth = 2;
      g.beginPath();
      for (let lon = -180; lon <= 180; lon += 15) {
        const x = ((lon + 180) / 360) * w;
        g.moveTo(x, 0);
        g.lineTo(x, h);
      }
      for (let lat = -90; lat <= 90; lat += 15) {
        const y = ((90 - lat) / 180) * h;
        g.moveTo(0, y);
        g.lineTo(w, y);
      }
      g.stroke();
    }
    g.fillStyle = o.land;
    g.strokeStyle = o.line;
    g.lineWidth = o.width;
    g.lineJoin = 'round';
    // A coast that crosses the date line (Chukotka, Fiji) is unwrapped so it
    // stays one shape, then drawn again a world to the left so both halves
    // land on the map. Lifting the pen instead left a wedge in the fill,
    // which the flat map shows.
    let shift = 0;
    const ring = (points: number[][]) => {
      let last = points[0]?.[0] ?? 0;
      points.forEach(([lon, lat], i) => {
        let x0 = lon;
        if (i > 0) {
          while (x0 - last > 180) x0 -= 360;
          while (x0 - last < -180) x0 += 360;
        }
        last = x0;
        const x = ((x0 + 180 + shift) / 360) * w;
        const y = ((90 - lat) / 180) * h;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.closePath();
    };
    const span = (part: number[][]) => {
      let last = part[0]?.[0] ?? 0;
      let lo = last;
      let hi = last;
      for (const [lon] of part) {
        let x0 = lon;
        while (x0 - last > 180) x0 -= 360;
        while (x0 - last < -180) x0 += 360;
        last = x0;
        lo = Math.min(lo, x0);
        hi = Math.max(hi, x0);
      }
      return [lo, hi];
    };
    for (const f of this.geo.features) {
      const geom = f.geometry as {
        type: string;
        coordinates: number[][][] | number[][][][];
      };
      const polys =
        geom.type === 'Polygon'
          ? [geom.coordinates as number[][][]]
          : (geom.coordinates as number[][][][]);
      for (const poly of polys) {
        const [lo, hi] = span(poly[0] ?? []);
        const shifts = [0];
        if (hi > 180) shifts.push(-360);
        if (lo < -180) shifts.push(360);
        for (const sh of shifts) {
          shift = sh;
          g.beginPath();
          for (const part of poly) ring(part);
          g.fill('evenodd');
          if (o.width) g.stroke();
        }
        shift = 0;
      }
    }
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  private put(c: Contact) {
    c.entity.show = this.shows(c);
    const ring = this.rings.get(c.id);
    if (ring) ring.show = this.shows(c) && !this.flat;
    this.contacts.set(c.id, c);
    this.rev += 1;
  }

  private drop(prefix: string, keep: Set<string>) {
    for (const [id, c] of this.contacts) {
      if (!id.startsWith(prefix) || keep.has(id)) continue;
      this.viewer.entities.remove(c.entity);
      this.contacts.delete(id);
      this.pos.delete(id);
      this.orbiters.delete(id);
      this.rev += 1;
      const ring = this.rings.get(id);
      if (ring) {
        this.viewer.entities.remove(ring);
        this.rings.delete(id);
      }
    }
  }

  // ------------------------------------------------------------ the network

  setNetwork(places: LivePlace[], events: LiveEvent[]) {
    const { C, viewer } = this;
    this.places = places;
    this.events = events;
    this.activity = new Map();
    for (const e of events) {
      this.activity.set(e.actor, (this.activity.get(e.actor) ?? 0) + 1);
      if (e.peer)
        this.activity.set(e.peer, (this.activity.get(e.peer) ?? 0) + 1);
    }

    const keep = new Set<string>();
    for (const p of places) {
      // A member without a declared location is never assigned one.
      if (!p.placed || p.lat === null || p.lon === null) continue;
      const id = `agt:${p.id}`;
      const act = this.activity.get(p.id) ?? 0;
      const tint = C.Color.fromCssColorString(FAMILY_COLOUR[familyOf(p.id)]);
      const details = [
        `Run by ${p.operator}`,
        `${p.state.replace(/^./, (c) => c.toUpperCase())} · ${p.karma} karma`,
        `In ${act} of the newest 80 ledger entries`,
      ];
      const existing = this.contacts.get(id);
      const placed = p.placed && p.lat !== null && p.lon !== null;
      if (existing && (existing.type === 'AGT') === placed) {
        keep.add(id);
        existing.details = [existing.details[0], ...details];
        existing.weight = 10 + act;
        const orb = this.orbiters.get(id);
        if (orb) orb.speed = 0.01 + Math.min(act, 12) * 0.0035;
        continue;
      }
      if (existing) {
        viewer.entities.remove(existing.entity);
        this.contacts.delete(id);
        this.pos.delete(id);
        this.orbiters.delete(id);
        const ring = this.rings.get(id);
        if (ring) {
          viewer.entities.remove(ring);
          this.rings.delete(id);
        }
      }
      if (p.placed && p.lat !== null && p.lon !== null) {
        keep.add(id);
        const height = 60_000 + Math.log10(p.karma + 1) * 220_000;
        this.pos.set(id, C.Cartesian3.fromDegrees(p.lon, p.lat, height));
        const entity = viewer.entities.add({
          id,
          position: this.position(id),
          point: {
            pixelSize: 9,
            color: tint,
            outlineColor: C.Color.WHITE.withAlpha(0.9),
            outlineWidth: 1,
          },
          polyline: {
            positions: [
              C.Cartesian3.fromDegrees(p.lon, p.lat, 0),
              C.Cartesian3.fromDegrees(p.lon, p.lat, height),
            ],
            width: 5,
            material: new C.PolylineGlowMaterialProperty({
              glowPower: 0.35,
              color: tint.withAlpha(0.9),
            }),
            arcType: C.ArcType.NONE,
          },
        });
        this.put({
          id,
          type: 'AGT',
          tier: 'uain',
          layer: 'ground',
          title: p.name,
          micro: p.region_label,
          details: [`Location: ${p.region_label}`, ...details],
          accent: FAMILY_COLOUR[familyOf(p.id)],
          range: 320_000,
          weight: 10 + act,
          entity,
        });
      } else {
        // No location given: it circles the Earth, one height per family.
        keep.add(id);
        const shell = { claude: 620_000, codex: 900_000, other: 1_250_000 }[
          familyOf(p.id)
        ];
        const orb: Orbiter = {
          radius: EARTH + shell + hash01(p.id, 1) * 160_000,
          inclination:
            (0.25 + hash01(p.id, 2) * 1.05) * (hash01(p.id, 3) > 0.5 ? 1 : -1),
          node: hash01(p.id, 4) * Math.PI * 2,
          phase: hash01(p.id, 5) * Math.PI * 2,
          speed: 0.01 + Math.min(act, 12) * 0.0035,
        };
        this.orbiters.set(id, orb);
        this.pos.set(id, this.orbitPoint(orb, orb.phase));
        const entity = viewer.entities.add({
          id,
          position: this.position(id, true),
          point: {
            pixelSize: 11,
            color: tint,
            outlineColor: C.Color.WHITE,
            outlineWidth: 1.5,
          },
        });
        const path: CesiumNS.Cartesian3[] = [];
        for (let i = 0; i <= 128; i += 1)
          path.push(this.orbitPoint(orb, (i / 128) * Math.PI * 2));
        const ring = viewer.entities.add({
          polyline: {
            positions: path,
            width: 1.2,
            material: tint.withAlpha(0.28),
            arcType: C.ArcType.NONE,
          },
          show: this.visible.orbit && !this.flat,
        });
        this.rings.set(id, ring);
        this.put({
          id,
          type: 'ORB',
          tier: 'uain',
          layer: 'orbit',
          title: p.name,
          micro: 'No location given',
          details: ['No location given, so it is drawn in orbit', ...details],
          accent: FAMILY_COLOUR[familyOf(p.id)],
          range: 1_100_000,
          weight: 12 + act,
          entity,
        });
      }
    }
    this.drop('agt:', keep);
    this.setLedger(events);
    this.setLinks(events);
    this.onChange();
  }

  private orbitPoint(o: Orbiter, theta: number) {
    const { C } = this;
    const ci = Math.cos(o.inclination);
    const si = Math.sin(o.inclination);
    const x = Math.cos(theta) * o.radius;
    const y0 = Math.sin(theta) * o.radius;
    // Tilt about the x axis, then turn about the pole.
    const y = y0 * ci;
    const z = y0 * si;
    const cn = Math.cos(o.node);
    const sn = Math.sin(o.node);
    return new C.Cartesian3(x * cn - y * sn, x * sn + y * cn, z);
  }

  /**
   * Each ledger entry names the hash of the one before it. Count the links
   * that can be checked from the newest entries, and any that do not match.
   */
  private setLedger(events: LiveEvent[]) {
    const ring = events.slice(0, RING_SIZE);
    let checked = 0;
    let broken = 0;
    ring.forEach((e, i) => {
      const next = ring[i + 1];
      if (
        next &&
        String(e.id).match(/^\d+$/) &&
        String(next.id).match(/^\d+$/) &&
        BigInt(e.id) === BigInt(next.id) + BigInt(1) &&
        e.prev_hash &&
        next.hash
      ) {
        checked += 1;
        if (e.prev_hash !== next.hash) broken += 1;
      }
    });
    this.chain = {
      checked,
      broken,
      head: ring[0]?.id ?? null,
      authority: ring[0]?.authority ?? 'legacy',
    };
  }

  private setLinks(events: LiveEvent[]) {
    const { C, viewer } = this;
    const wanted = events
      .filter(
        (e) =>
          e.peer &&
          e.peer !== e.actor &&
          this.contacts.has(`agt:${e.actor}`) &&
          this.contacts.has(`agt:${e.peer}`),
      )
      .slice(0, LINK_COUNT);
    const keep = new Set(wanted.map((e) => e.id));
    for (const l of this.links.filter((x) => !keep.has(x.key))) {
      viewer.entities.remove(l.line);
      viewer.entities.remove(l.packet);
    }
    const have = new Map(
      this.links.filter((l) => keep.has(l.key)).map((l) => [l.key, l]),
    );
    const first = this.links.length === 0;
    this.links = wanted.map((e) => {
      const old = have.get(e.id);
      if (old) return old;
      const tint = C.Color.fromCssColorString(KIND_COLOUR[e.kind] ?? '#8db4ff');
      const link: Link = {
        key: e.id,
        a: `agt:${e.actor}`,
        b: `agt:${e.peer}`,
        // A brand-new entry flashes; the backlog starts already settled.
        born: first ? -99 : this.clock(),
        curve: [],
        line: undefined as unknown as CesiumNS.Entity,
        packet: undefined as unknown as CesiumNS.Entity,
      };
      link.line = viewer.entities.add({
        polyline: {
          positions: new C.CallbackProperty(() => link.curve, false),
          width: 4,
          material: new C.PolylineGlowMaterialProperty({
            glowPower: 0.22,
            color: new C.CallbackProperty(() => {
              const hot = Math.max(0, 1 - (this.clock() - link.born) / 3.5);
              return tint.withAlpha(0.22 + hot * 0.7);
            }, false),
          }),
          arcType: C.ArcType.NONE,
        },
        show: this.visible.links,
      });
      link.packet = viewer.entities.add({
        position: new C.CallbackProperty(() => {
          const u = (this.clock() - link.born) / 1.8;
          if (u < 0 || u > 1 || link.curve.length === 0) return undefined;
          return link.curve[Math.round(u * (link.curve.length - 1))];
        }, false) as unknown as CesiumNS.PositionProperty,
        point: {
          pixelSize: 9,
          color: C.Color.WHITE,
          outlineColor: tint,
          outlineWidth: 2,
        },
        show: this.visible.links,
      });
      return link;
    });
  }

  /** The newest link fired, for the toast and the tour. */
  fire(eventId: number | string) {
    const link = this.links.find((l) => l.key === eventId);
    if (link) link.born = this.clock();
  }

  async setFindings(findings: BriefFinding[]) {
    const { C, viewer } = this;
    if (!this.geo) {
      this.geo = (await fetch('/geo/countries.json').then((r) => r.json())) as {
        features: GeoFeature[];
      };
    }
    const names = this.geo.features.map((f) => f.properties.name);
    const rows = findingsByCountry(findings, names);
    const key = [...rows.values()]
      .map((r) => `${r.country}:${r.hotline}:${r.findings.length}`)
      .join('|');
    if (key === this.countriesKey) return;
    this.countriesKey = key;

    if (this.countries) {
      if (viewer.dataSources.contains(this.countries))
        viewer.dataSources.remove(this.countries, true);
      else this.countries.entities.removeAll();
    }
    this.drop('lnd:', new Set());
    const features = this.geo.features.filter((f) =>
      rows.has(f.properties.name),
    );
    const source = await C.GeoJsonDataSource.load(
      { type: 'FeatureCollection', features },
      { clampToGround: false },
    );
    const showing = this.visible.findings && !this.close;
    source.show = showing;
    const seen = new Set<string>();
    for (const entity of source.entities.values) {
      const name = entity.properties?.name?.getValue() as string | undefined;
      const row = name ? rows.get(name) : undefined;
      if (!row || !entity.polygon) continue;
      const css =
        row.hotline === 'line'
          ? '#3fe0a8'
          : row.hotline === 'gap'
            ? '#ffae42'
            : '#6bc8ff';
      const tint = C.Color.fromCssColorString(css);
      entity.polygon.material = new C.ColorMaterialProperty(
        tint.withAlpha(0.42),
      );
      entity.polygon.outline = new C.ConstantProperty(true);
      entity.polygon.outlineColor = new C.ConstantProperty(tint);
      entity.polygon.height = new C.ConstantProperty(0);
      entity.polygon.extrudedHeight = new C.ConstantProperty(
        25_000 + Math.min(4, row.findings.length) * 18_000,
      );
      // One contact per country, anchored on its largest piece.
      const hierarchy = entity.polygon.hierarchy?.getValue(
        C.JulianDate.now(),
      ) as CesiumNS.PolygonHierarchy | undefined;
      if (!hierarchy) continue;
      const sphere = C.BoundingSphere.fromPoints(hierarchy.positions);
      const id = `lnd:${name}`;
      const prior = this.contacts.get(id);
      if (prior && seen.has(id) && prior.range >= sphere.radius * 3.2) continue;
      seen.add(id);
      const carto = C.Cartographic.fromCartesian(sphere.center);
      const anchor = C.Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        90_000,
      );
      this.pos.set(id, anchor);
      if (prior) viewer.entities.remove(prior.entity);
      const marker = viewer.entities.add({ id, position: this.position(id) });
      const settled = row.findings.filter((f) => f.state === 'settled').length;
      this.put({
        id,
        type: 'LND',
        tier: 'earth',
        layer: 'findings',
        title: row.country,
        micro:
          row.hotline === 'line'
            ? 'Crisis hotline confirmed'
            : row.hotline === 'gap'
              ? 'No official hotline found'
              : `${row.findings.length} findings`,
        details: [
          `${row.findings.length} finding${row.findings.length === 1 ? '' : 's'} about this country, ${settled} accepted`,
          ...row.findings.slice(0, 3).map((f) => f.title.slice(0, 140)),
        ],
        accent: css,
        range: Math.max(700_000, sphere.radius * 2.2),
        weight: row.hotline ? 8 : 6,
        hotline: row.hotline,
        entity: marker,
      });
    }
    if (showing) await viewer.dataSources.add(source);
    this.countries = source;
    this.onChange();
  }

  // ------------------------------------------------------------- the planet

  async loadNight() {
    const { C, viewer } = this;
    viewer.scene.globe.enableLighting = this.visible.night && !this.close;
    const provider = new C.UrlTemplateImageryProvider({
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
      maximumLevel: 8,
      credit: 'Night lights: NASA Earth Observatory, Black Marble',
    });
    const layer = viewer.imageryLayers.addImageryProvider(provider);
    layer.dayAlpha = 0;
    layer.nightAlpha = 1;
    layer.brightness = 2.2;
    layer.show = this.visible.night && !this.close;
    this.nightLayer = layer;
  }

  async loadSatellites() {
    const { C, viewer } = this;
    const groups = ['stations', 'visual', 'gps-ops'];
    const seen = new Set<string>();
    for (const group of groups) {
      const text = await this.elements(group);
      if (!text) continue;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      for (let i = 0; i + 2 < lines.length; i += 3) {
        const name = lines[i].trim();
        const norad = lines[i + 1].slice(2, 7).trim();
        if (seen.has(norad)) continue;
        seen.add(norad);
        let rec: SatRec;
        try {
          rec = twoline2satrec(lines[i + 1], lines[i + 2]);
        } catch {
          continue;
        }
        this.sats.push({ id: `sat:${norad}`, name, rec, group });
      }
    }
    const now = new Date();
    for (const s of this.sats) {
      const p = this.satPoint(s.rec, now);
      if (!p) continue;
      this.pos.set(s.id, p);
      const iss = s.id === 'sat:25544';
      const css = iss
        ? '#ff4444'
        : s.group === 'stations'
          ? '#fff6e5'
          : s.group === 'gps-ops'
            ? '#4fd8ff'
            : '#9fb3c4';
      const entity = viewer.entities.add({
        id: s.id,
        position: this.position(s.id, true),
        point: {
          pixelSize: iss ? 10 : s.group === 'visual' ? 3.5 : 5,
          color: C.Color.fromCssColorString(css),
          outlineColor: iss ? C.Color.WHITE : C.Color.TRANSPARENT,
          outlineWidth: iss ? 1.5 : 0,
        },
      });
      const alt = (C.Cartesian3.magnitude(p) - EARTH) / 1000;
      this.put({
        id: s.id,
        type: 'SAT',
        tier: 'space',
        layer: 'sats',
        title: s.name,
        micro: 'Real satellite',
        details: [
          `A real satellite, ${Math.round(alt).toLocaleString('en')} km up`,
          `Catalogue number ${s.id.slice(4)}`,
          'Position worked out from CelesTrak orbit data',
        ],
        accent: iss ? '#ff6b5a' : '#bda4ff',
        range: alt > 2000 ? 4_000_000 : 900_000,
        weight: iss ? 30 : s.group === 'stations' ? 3 : 0,
        entity,
      });
    }
    this.showSatRing('sat:25544');
    this.onChange();
  }

  /**
   * One group's orbital elements. CelesTrak refuses a caller that asks for the
   * same file again within two hours, so the answer is kept in the browser.
   */
  private async elements(group: string): Promise<string | null> {
    const key = `uain.obs.tle.${group}`;
    try {
      const kept = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        at: number;
        text: string;
      } | null;
      if (kept && Date.now() - kept.at < 6 * 3_600_000) return kept.text;
      const res = await fetch(
        `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`,
      );
      if (!res.ok) return kept?.text ?? null;
      const text = await res.text();
      if (!/^1 \d{5}/m.test(text)) return kept?.text ?? null;
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), text }));
      return text;
    } catch {
      return null;
    }
  }

  private satPoint(rec: SatRec, date: Date) {
    const pv = propagate(rec, date);
    const p = pv && typeof pv.position === 'object' ? pv.position : null;
    if (!p || !Number.isFinite(p.x)) return null;
    const f = eciToEcf(p, gstime(date));
    return new this.C.Cartesian3(f.x * 1000, f.y * 1000, f.z * 1000);
  }

  /** One orbit of a real satellite, drawn where it will be over the ground. */
  showSatRing(id: string) {
    const { C, viewer } = this;
    const sat = this.sats.find((s) => s.id === id);
    if (!sat) return;
    if (
      this.satRing &&
      this.satRing.id !== 'sat:25544' &&
      this.satRing.id !== id
    )
      viewer.entities.remove(this.satRing.entity);
    const gmst = gstime(new Date());
    const period = (2 * Math.PI) / sat.rec.no; // minutes
    const points: CesiumNS.Cartesian3[] = [];
    for (let i = 0; i <= 180; i += 1) {
      const when = new Date(Date.now() + (i / 180) * period * 60_000);
      const pv = propagate(sat.rec, when);
      const p = pv && typeof pv.position === 'object' ? pv.position : null;
      if (!p || !Number.isFinite(p.x)) continue;
      // Held at one sidereal time, so the ring closes on itself.
      const f = eciToEcf(p, gmst);
      points.push(new C.Cartesian3(f.x * 1000, f.y * 1000, f.z * 1000));
    }
    const existing = this.rings.get(id);
    if (existing) viewer.entities.remove(existing);
    const entity = viewer.entities.add({
      polyline: {
        positions: points,
        width: id === 'sat:25544' ? 2 : 1.6,
        material: C.Color.fromCssColorString(
          id === 'sat:25544' ? '#ff6b5a' : '#ffd84d',
        ).withAlpha(0.6),
        arcType: C.ArcType.NONE,
      },
      show: this.visible.sats,
    });
    this.rings.set(id, entity);
    if (id !== 'sat:25544') this.satRing = { id, at: Date.now(), entity };
  }

  async loadQuakes() {
    const { C, viewer } = this;
    let body: {
      features: {
        id: string;
        properties: { mag: number; place: string; time: number };
        geometry: { coordinates: [number, number, number] };
      }[];
    };
    try {
      body = await fetch(
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
      ).then((r) => r.json());
    } catch {
      return;
    }
    const keep = new Set<string>();
    for (const f of body.features) {
      const [lon, lat, depth] = f.geometry.coordinates;
      const mag = f.properties.mag ?? 0;
      const id = `qke:${f.id}`;
      keep.add(id);
      if (this.contacts.has(id)) continue;
      const css = depth < 70 ? '#ff5a4a' : depth < 300 ? '#ff9a3c' : '#ffd84d';
      const tint = C.Color.fromCssColorString(css);
      this.pos.set(id, C.Cartesian3.fromDegrees(lon, lat, 0));
      const entity = viewer.entities.add({
        id,
        position: this.position(id),
        ellipse: {
          semiMajorAxis: 2 ** mag * 2200,
          semiMinorAxis: 2 ** mag * 2200,
          material: tint.withAlpha(mag >= 5 ? 0.4 : 0.28),
          outline: true,
          outlineColor: tint,
          height: 0,
        },
        point: { pixelSize: 4, color: tint },
      });
      this.put({
        id,
        type: 'QKE',
        tier: 'earth',
        layer: 'quakes',
        title: `Earthquake, magnitude ${mag.toFixed(1)}`,
        micro: f.properties.place ?? 'Unknown place',
        details: [
          f.properties.place ?? 'Unknown place',
          `${Math.round(depth)} km deep`,
          `${new Date(f.properties.time).toISOString().replace('T', ' ').slice(0, 16)} UTC · source: USGS`,
        ],
        accent: css,
        range: 450_000,
        weight: mag >= 5 ? 5 : 0,
        magnitude: mag,
        at: f.properties.time,
        severity: Math.min(1, Math.max(0.05, (mag - 2.5) / 4.5)),
        entity,
      });
    }
    this.drop('qke:', keep);
    this.onChange();
  }

  async loadEvents() {
    const { C, viewer } = this;
    let body: {
      events: {
        id: string;
        title: string;
        categories: { id: string; title: string }[];
        geometry: { date: string; type: string; coordinates: number[] }[];
      }[];
    };
    try {
      body = await fetch(
        'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=120',
      ).then((r) => r.json());
    } catch {
      return;
    }
    const colour: Record<string, string> = {
      wildfires: '#ff7a3c',
      severeStorms: '#7fc8ff',
      volcanoes: '#ff4d6d',
      seaLakeIce: '#d8f2ff',
    };
    for (const e of body.events) {
      const last = e.geometry.at(-1);
      if (!last || last.type !== 'Point') continue;
      const id = `evt:${e.id}`;
      if (this.contacts.has(id)) continue;
      const cat = e.categories[0];
      const css = colour[cat?.id ?? ''] ?? '#ffd84d';
      const tint = C.Color.fromCssColorString(css);
      // NASA lists some fires twice on one spot. The later one stands about
      // 30 m east, so the flat map's group of them can still come apart.
      let lon = last.coordinates[0];
      const lat = last.coordinates[1];
      const spot = () => `${lon.toFixed(4)},${lat.toFixed(4)}`;
      while (this.eventSpots.has(spot())) lon += 0.0003;
      this.eventSpots.add(spot());
      this.pos.set(id, C.Cartesian3.fromDegrees(lon, lat, 0));
      const entity = viewer.entities.add({
        id,
        position: this.position(id),
        point: {
          pixelSize: 7,
          color: tint.withAlpha(0.9),
          outlineColor: C.Color.BLACK.withAlpha(0.7),
          outlineWidth: 1,
        },
      });
      this.put({
        id,
        type: 'EVT',
        tier: 'earth',
        layer: 'events',
        title: e.title.slice(0, 44),
        micro: cat?.title ?? 'Natural event',
        details: [
          cat?.title ?? 'Natural event',
          `Last reported ${last.date.slice(0, 10)}`,
          'Source: NASA',
        ],
        accent: css,
        range: 350_000,
        weight: 0,
        at: Date.parse(last.date) || Date.now(),
        severity:
          { severeStorms: 0.75, volcanoes: 0.6, wildfires: 0.3 }[
            cat?.id ?? ''
          ] ?? 0.35,
        entity,
      });
    }
    this.onChange();
  }

  /**
   * Every data center mapped on OpenStreetMap, from a snapshot kept with the
   * site (`scripts/fetch-data-centers.mjs` refreshes it). Returns the
   * snapshot's date, or null when it could not be read.
   */
  async loadDataCenters(): Promise<string | null> {
    const { C, viewer } = this;
    let body: {
      fetched: string;
      centers: [number, number, string, string][];
    };
    try {
      body = await fetch('/geo/data-centers.json').then((r) => r.json());
    } catch {
      return null;
    }
    const css = '#3fd6c0';
    const tint = C.Color.fromCssColorString(css);
    viewer.entities.suspendEvents();
    body.centers.forEach(([lon, lat, name, operator], i) => {
      const id = `dcr:${i}`;
      if (this.contacts.has(id)) return;
      this.pos.set(id, C.Cartesian3.fromDegrees(lon, lat, 0));
      const entity = viewer.entities.add({
        id,
        position: this.position(id),
        point: {
          pixelSize: 5,
          color: tint.withAlpha(0.9),
          outlineColor: C.Color.BLACK.withAlpha(0.7),
          outlineWidth: 1,
        },
      });
      this.put({
        id,
        type: 'DCR',
        tier: 'earth',
        layer: 'datacenters',
        title: (name || operator || 'Data center').slice(0, 44),
        micro: operator || 'Data center',
        details: [
          ...(operator && name ? [`Run by ${operator}`] : []),
          `On OpenStreetMap as of ${body.fetched}`,
        ],
        accent: css,
        range: 200_000,
        weight: 0,
        entity,
      });
    });
    viewer.entities.resumeEvents();
    this.onChange();
    return body.fetched;
  }

  /**
   * The topic list (Kenneth's Benevolent AI Master List, 12 October 2026):
   * problems to solve and opportunities, in domains and sub-domains. A topic
   * has no place, so a sub-domain is one red dot for its problems and one
   * white dot for its opportunities, at a fixed spot (`topicSpot`). Returns
   * the index, or null when it could not be read.
   */
  async loadTopics(): Promise<TopicIndex | null> {
    const { C, viewer } = this;
    let index: TopicIndex;
    try {
      index = await fetch('/geo/topics/index.json').then((r) => r.json());
    } catch {
      return null;
    }
    viewer.entities.suspendEvents();
    for (const d of index.domains)
      for (const s of d.subs)
        for (const opportunity of [false, true]) {
          const id = topicId(s.n, opportunity);
          const count = opportunity ? s.opp : s.prb;
          if (this.contacts.has(id) || !count) continue;
          const spot = topicSpot(s.n, opportunity);
          this.pos.set(id, C.Cartesian3.fromDegrees(spot.lon, spot.lat, 0));
          const css = opportunity ? '#ffffff' : '#f0503a';
          const entity = viewer.entities.add({
            id,
            position: this.position(id),
            point: {
              pixelSize: 7,
              color: C.Color.fromCssColorString(css).withAlpha(0.9),
              outlineColor: C.Color.BLACK.withAlpha(0.7),
              outlineWidth: 1,
            },
          });
          this.put({
            id,
            type: 'TOP',
            tier: 'earth',
            layer: opportunity ? 'opportunityTopics' : 'problemTopics',
            title: s.name.slice(0, 44),
            micro: `${count} ${opportunity ? 'opportunities' : 'problems to solve'}`,
            details: [d.name],
            accent: css,
            range: 900_000,
            weight: 0,
            count,
            entity,
          });
        }
    viewer.entities.resumeEvents();
    this.onChange();
    return index;
  }

  // --------------------------------------------------------------- per frame

  /** The thing the camera follows is placed every frame, so it moves smoothly. */
  setFollowed(id: string | null) {
    this.followed = id;
  }

  private tick() {
    const t = this.clock();
    const now = new Date();

    // Nothing that is switched off is worked out.
    const linked = this.visible.links && this.links.length > 0;
    if (this.visible.orbit || linked)
      for (const [id, o] of this.orbiters)
        this.pos.set(id, this.orbitPoint(o, o.phase + o.speed * t));
    if (this.visible.sats) {
      // A satellite's place takes real arithmetic: twice a second is plenty
      // from this far away. The one being followed is done every frame.
      const all = t - this.lastSats > 0.5;
      if (all) this.lastSats = t;
      for (const s of this.sats) {
        if (!all && s.id !== this.followed) continue;
        const p = this.satPoint(s.rec, now);
        if (p) this.pos.set(s.id, p);
      }
    }
    if (!linked) return this.afterTick();

    // Re-fire one recent link every few seconds, so the last hour of the
    // ledger keeps echoing across the globe between new entries.
    if (this.links.length && t - this.lastEcho > 2.4) {
      this.lastEcho = t;
      this.echo = (this.echo + 1) % this.links.length;
      this.links[this.echo].born = t;
    }
    for (const link of this.links) {
      const a = this.pos.get(link.a);
      const b = this.pos.get(link.b);
      if (!a || !b) {
        link.curve = [];
        continue;
      }
      link.curve = this.arc(a, b);
    }

    this.afterTick();
  }

  private afterTick() {
    if (this.focus) {
      // Anything added while in focus stays out of the way, and a line to an
      // AI in orbit follows it.
      this.applyLines();
      for (const fl of this.focusLines) {
        if (!fl.moving) continue;
        const a = this.pos.get(fl.a);
        const b = this.pos.get(fl.b);
        if (a && b) fl.curve = this.arc(a, b);
      }
    }
    // A stream from an AI in orbit bends as the AI moves.
    for (const st of this.streams) {
      if (!st.moving || !this.visible[st.layer]) continue;
      const a = this.pos.get(st.from);
      const b = this.pos.get(st.to);
      if (a && b) st.curve = this.arc(a, b);
    }
    // A tracked satellite's ring drifts with the Earth's turn: redraw it.
    if (this.satRing && Date.now() - this.satRing.at > 20_000)
      this.showSatRing(this.satRing.id);
  }

  /** A lifted curve between two points, so a line clears the Earth. */
  private arc(a: CesiumNS.Cartesian3, b: CesiumNS.Cartesian3) {
    const { C } = this;
    const mid = C.Cartesian3.midpoint(a, b, new C.Cartesian3());
    const lift =
      Math.max(C.Cartesian3.magnitude(a), C.Cartesian3.magnitude(b)) +
      C.Cartesian3.distance(a, b) * 0.3 +
      120_000;
    const ctrl =
      C.Cartesian3.magnitude(mid) < 1000
        ? C.Cartesian3.multiplyByScalar(
            C.Cartesian3.normalize(a, new C.Cartesian3()),
            lift,
            new C.Cartesian3(),
          )
        : C.Cartesian3.multiplyByScalar(
            C.Cartesian3.normalize(mid, mid),
            lift,
            new C.Cartesian3(),
          );
    const curve: CesiumNS.Cartesian3[] = [];
    for (let i = 0; i <= CURVE_STEPS; i += 1) {
      const u = i / CURVE_STEPS;
      const w = 1 - u;
      curve.push(
        new C.Cartesian3(
          a.x * w * w + ctrl.x * 2 * w * u + b.x * u * u,
          a.y * w * w + ctrl.y * 2 * w * u + b.y * u * u,
          a.z * w * w + ctrl.z * 2 * w * u + b.z * u * u,
        ),
      );
    }
    return curve;
  }

  /**
   * The concept view's invented AIs, drawn the way real ones are: a pillar
   * where one says it is, or an orbit when it gives no location.
   */
  setCast(
    cast: {
      id: string;
      name: string;
      home?: { name: string; lat: number; lon: number };
      details: string[];
      weight: number;
      /** Its own colour, where it is not one of the crowd. */
      tint?: string;
    }[],
  ) {
    const { C, viewer } = this;
    const keep = new Set(cast.map((a) => a.id));
    for (const a of cast) {
      const css = a.tint ?? '#c9a7ff';
      const tint = C.Color.fromCssColorString(css);
      const existing = this.contacts.get(a.id);
      if (existing && existing.title === a.name) {
        existing.weight = a.weight;
        existing.details = a.details;
        continue;
      }
      // The cast changed under this id (the real examples arrived): the old
      // one is taken off before the new one is drawn.
      if (existing) {
        viewer.entities.remove(existing.entity);
        this.contacts.delete(a.id);
        this.orbiters.delete(a.id);
        const ring = this.rings.get(a.id);
        if (ring) {
          viewer.entities.remove(ring);
          this.rings.delete(a.id);
        }
      }
      if (a.home) {
        // Several live in one city: each gets its own spot near it.
        const lat = a.home.lat + (hash01(a.id, 11) - 0.5) * 3.2;
        const lon = a.home.lon + (hash01(a.id, 12) - 0.5) * 3.2;
        const height = 120_000 + hash01(a.id, 13) * 380_000;
        this.pos.set(a.id, C.Cartesian3.fromDegrees(lon, lat, height));
        const entity = viewer.entities.add({
          id: a.id,
          position: this.position(a.id),
          point: {
            pixelSize: 9,
            color: tint,
            outlineColor: C.Color.WHITE.withAlpha(0.9),
            outlineWidth: 1,
          },
          polyline: {
            positions: [
              C.Cartesian3.fromDegrees(lon, lat, 0),
              C.Cartesian3.fromDegrees(lon, lat, height),
            ],
            width: 5,
            material: new C.PolylineGlowMaterialProperty({
              glowPower: 0.35,
              color: tint.withAlpha(0.9),
            }),
            arcType: C.ArcType.NONE,
          },
        });
        this.put({
          id: a.id,
          type: 'AGT',
          tier: 'uain',
          layer: 'ground',
          title: a.name,
          micro: a.home.name,
          details: a.details,
          accent: css,
          range: 320_000,
          weight: a.weight,
          sim: true,
          entity,
        });
      } else {
        const orb: Orbiter = {
          radius: EARTH + 700_000 + hash01(a.id, 1) * 700_000,
          inclination:
            (0.25 + hash01(a.id, 2) * 1.05) * (hash01(a.id, 3) > 0.5 ? 1 : -1),
          node: hash01(a.id, 4) * Math.PI * 2,
          phase: hash01(a.id, 5) * Math.PI * 2,
          speed: 0.01 + Math.min(a.weight, 6) * 0.004,
        };
        this.orbiters.set(a.id, orb);
        this.pos.set(a.id, this.orbitPoint(orb, orb.phase));
        const entity = viewer.entities.add({
          id: a.id,
          position: this.position(a.id, true),
          point: {
            pixelSize: 11,
            color: tint,
            outlineColor: C.Color.WHITE,
            outlineWidth: 1.5,
          },
        });
        const path: CesiumNS.Cartesian3[] = [];
        for (let i = 0; i <= 128; i += 1)
          path.push(this.orbitPoint(orb, (i / 128) * Math.PI * 2));
        this.rings.set(
          a.id,
          viewer.entities.add({
            polyline: {
              positions: path,
              width: 1.2,
              material: tint.withAlpha(0.07),
              arcType: C.ArcType.NONE,
            },
          }),
        );
        this.put({
          id: a.id,
          type: 'ORB',
          tier: 'uain',
          layer: 'orbit',
          title: a.name,
          micro: 'No location given',
          details: a.details,
          accent: css,
          range: 1_100_000,
          weight: a.weight,
          sim: true,
          entity,
        });
      }
    }
    for (const [id, c] of this.contacts) {
      if (!c.sim || keep.has(id)) continue;
      viewer.entities.remove(c.entity);
      this.contacts.delete(id);
      this.pos.delete(id);
      this.orbiters.delete(id);
      const ring = this.rings.get(id);
      if (ring) {
        viewer.entities.remove(ring);
        this.rings.delete(id);
      }
    }
  }

  /**
   * The concept view's flows: a stream from an AI to the problem it works
   * on. One from an AI on the ground is worked out once; one from an AI in
   * orbit follows it.
   */
  setStreams(
    wanted: {
      key: string;
      from: string;
      to: string;
      tint: string;
      layer: StreamLayerId;
      /** Drawn brighter than a flow, to stand out among them. */
      bold?: boolean;
    }[],
  ) {
    const { C, viewer } = this;
    const keep = new Set(wanted.map((w) => w.key));
    for (const st of this.streams.filter((x) => !keep.has(x.key))) {
      viewer.entities.remove(st.line);
      viewer.entities.remove(st.packet);
    }
    const have = new Map(
      this.streams.filter((x) => keep.has(x.key)).map((x) => [x.key, x]),
    );
    this.streams = wanted.flatMap((w) => {
      const old = have.get(w.key);
      if (old) return [old];
      const start = this.pos.get(w.from);
      const end = this.pos.get(w.to);
      if (!start || !end) return [];
      const st: Stream = {
        key: w.key,
        layer: w.layer,
        from: w.from,
        to: w.to,
        moving: this.orbiters.has(w.from),
        curve: this.arc(start, end),
        line: undefined as unknown as CesiumNS.Entity,
        packet: undefined as unknown as CesiumNS.Entity,
      };
      const tint = C.Color.fromCssColorString(w.tint);
      const phase = hash01(w.key, 9) * 3;
      st.line = viewer.entities.add({
        polyline: {
          positions: st.moving
            ? new C.CallbackProperty(() => st.curve, false)
            : st.curve,
          width: 2.5,
          material: new C.PolylineGlowMaterialProperty({
            glowPower: 0.2,
            color: tint.withAlpha(w.bold ? 0.65 : 0.3),
          }),
          arcType: C.ArcType.NONE,
        },
        show: this.visible[w.layer],
      });
      st.packet = viewer.entities.add({
        position: new C.CallbackProperty(() => {
          const u = ((this.clock() + phase) % 3) / 3;
          return st.curve[Math.round(u * (st.curve.length - 1))];
        }, false) as unknown as CesiumNS.PositionProperty,
        point: {
          pixelSize: 5,
          color: C.Color.WHITE,
          outlineColor: tint,
          outlineWidth: 1.5,
        },
        show: this.visible[w.layer],
      });
      return [st];
    });
    this.applyLines();
  }

  /**
   * Looking back in time: an event that had not happened yet is hidden.
   * `null` is now.
   */
  setHorizon(at: number | null) {
    this.horizon = at;
    this.applyHorizon();
  }

  private applyHorizon() {
    this.applyShown();
  }

  /**
   * Whether a thing is drawn: its layer is on, it exists at the moment being
   * shown, and it belongs to the view in use. The real AIs and the invented
   * ones of the concept view are never on the globe together.
   */
  shows(c: Contact) {
    return !this.grouped.has(c.id) && this.listed(c);
  }

  /** The same, before the flat map's grouping: a grouped dot is still listed. */
  listed(c: Contact) {
    // While one problem is in focus, only it and its AIs are drawn.
    if (this.focus) return this.focus.has(c.id) && this.present(c);
    // A filter keeps the chosen projects only, so the topic list steps out.
    if (
      this.only &&
      (c.type === 'QKE' ||
        c.type === 'EVT' ||
        c.type === 'PRJ' ||
        c.type === 'TOP') &&
      !this.only.has(c.id)
    )
      return false;
    return (
      this.visible[c.layer] &&
      this.present(c) &&
      (c.tier !== 'uain' || !!c.sim === this.simMode)
    );
  }

  /** The dots the flat map has folded into groups, which it draws itself. */
  setGrouped(ids: Set<string>) {
    this.grouped = ids;
    const { rev } = this;
    this.applyShown();
    this.rev = rev;
  }

  /**
   * Show only these problems and opportunities, whatever their layers say;
   * `null` shows them all again. Nothing else on the map is touched.
   */
  setOnly(ids: Set<string> | null) {
    this.only = ids;
    this.applyShown();
  }

  /** Whether the flat map is showing: it draws the orbiters without rings. */
  setFlat(flat: boolean) {
    if (flat === this.flat) return;
    this.flat = flat;
    this.applyShown();
  }

  /** Whether a thing circles the Earth, so it has no fixed spot on the map. */
  moves(id: string) {
    return this.orbiters.has(id);
  }

  /**
   * The network's own projects. Research on a disease or a theory has no
   * place, so each is given a spot of its own somewhere on the globe, the
   * same one every time, to stay visible (architecture meeting, 8 October
   * 2026: non-geographical projects are mapped across the globe). The spot
   * is worked out from the project's id and means nothing.
   */
  setProjects(
    list: {
      id: string;
      title: string;
      opportunity: boolean;
      details: string[];
      /**
       * Where it stands, when it works under an item of the topic list. It
       * is then that item being worked on, so it adds nothing to a group's
       * number.
       */
      at?: { lon: number; lat: number };
    }[],
    /** The concept view's are Kalki's missions, kept apart from the real ones. */
    prefix: 'prj:' | 'cpj:' = 'prj:',
    simulated = prefix === 'cpj:',
  ) {
    const { C, viewer } = this;
    const mission = prefix === 'cpj:';
    const sim = simulated;
    const keep = new Set<string>();
    for (const pr of list) {
      const id = `${prefix}${pr.id}`;
      keep.add(id);
      // Clear of the poles and of the date line, where the flat map ends.
      const spot = pr.at ?? {
        lon: -165 + hash01(`${pr.id}|lon`) * 330,
        lat: -45 + hash01(`${pr.id}|lat`) * 100,
      };
      const where = C.Cartesian3.fromDegrees(spot.lon, spot.lat, 0);
      const existing = this.contacts.get(id);
      if (existing) {
        existing.title = pr.title.slice(0, 44);
        existing.details = pr.details;
        if (pr.at) existing.count = 0;
        // Its topic became known after it was drawn: it moves there.
        const was = this.pos.get(id);
        if (was && !C.Cartesian3.equalsEpsilon(was, where, 0, 1)) {
          this.pos.set(id, where);
          existing.entity.position = this.position(id);
          this.rev += 1;
        }
        continue;
      }
      this.pos.set(id, where);
      // Kalki's missions wear Kalki's yellow, not a problem's red or an
      // opportunity's white.
      const css = mission ? '#ffd84d' : pr.opportunity ? '#ffffff' : '#f0503a';
      const entity = viewer.entities.add({
        id,
        position: this.position(id),
        point: {
          pixelSize: 10,
          color: C.Color.fromCssColorString(css),
          outlineColor: C.Color.fromCssColorString(
            mission ? '#0b1020' : '#4d8dff',
          ),
          outlineWidth: 2,
        },
      });
      this.put({
        id,
        type: 'PRJ',
        tier: 'uain',
        layer: mission
          ? 'missions'
          : pr.opportunity
            ? 'opportunities'
            : 'projects',
        title: pr.title.slice(0, 44),
        micro: mission
          ? 'Kalki mission'
          : pr.opportunity
            ? 'Opportunity'
            : 'Problem',
        details: pr.details,
        accent: css,
        range: 320_000,
        weight: 9,
        ...(pr.at ? { count: 0 } : {}),
        ...(sim ? { sim: true } : {}),
        entity,
      });
    }
    this.drop(prefix, keep);
  }

  get inFocus() {
    return this.focus !== null;
  }

  private applyShown() {
    this.rev += 1;
    for (const c of this.contacts.values()) {
      const on = this.shows(c);
      c.entity.show = on;
      const ring = this.rings.get(c.id);
      if (ring && c.tier === 'uain') ring.show = on && !this.flat;
    }
    for (const [key, ring] of this.rings)
      if (key.startsWith('sat:')) ring.show = this.visible.sats && !this.focus;
    this.applyLines();
  }

  /** The everyday lines step aside while a problem is in focus. */
  private applyLines() {
    const free = !this.focus;
    for (const st of this.streams) {
      // A stream to something hidden would end in nothing.
      const to = this.contacts.get(st.to);
      const on = free && this.visible[st.layer] && (!to || this.listed(to));
      st.line.show = on;
      st.packet.show = on;
    }
    for (const l of this.links) {
      l.line.show = free && this.visible.links;
      l.packet.show = free && this.visible.links;
    }
    // An opened problem's own lines are always drawn: opening it is asking
    // to see who is on it. (They used to answer to the flow switches, which
    // are off unless Collaborations is chosen.)
    for (const fl of this.focusLines) {
      fl.entity.show = true;
      if (fl.packet) fl.packet.show = true;
    }
  }

  /**
   * Put one problem in focus: everything but it and its AIs is hidden, and
   * the given lines are drawn between them. `null` brings everything back.
   */
  setFocus(
    focus: {
      ids: string[];
      lines: {
        a: string;
        b: string;
        tint: string;
        strong: boolean;
      }[];
    } | null,
  ) {
    const { C, viewer } = this;
    const key = focus
      ? `${focus.ids.join(',')}|${focus.lines.map((l) => l.a + l.b).join(',')}`
      : '';
    if (key === this.focusKey) return;
    this.focusKey = key;
    for (const fl of this.focusLines) {
      viewer.entities.remove(fl.entity);
      if (fl.packet) viewer.entities.remove(fl.packet);
    }
    this.focusLines = [];
    this.focus = focus ? new Set(focus.ids) : null;
    for (const l of focus?.lines ?? []) {
      const a = this.pos.get(l.a);
      const b = this.pos.get(l.b);
      if (!a || !b) continue;
      const fl = {
        a: l.a,
        b: l.b,
        moving: this.orbiters.has(l.a) || this.orbiters.has(l.b),
        curve: this.arc(a, b),
        entity: undefined as unknown as CesiumNS.Entity,
        packet: undefined as CesiumNS.Entity | undefined,
      };
      const phase = hash01(l.a + l.b, 9) * 3;
      const tint = C.Color.fromCssColorString(l.tint);
      fl.entity = viewer.entities.add({
        polyline: {
          positions: fl.moving
            ? new C.CallbackProperty(() => fl.curve, false)
            : fl.curve,
          width: l.strong ? 4 : 2,
          material: l.strong
            ? new C.PolylineGlowMaterialProperty({
                glowPower: 0.22,
                color: tint.withAlpha(0.9),
              })
            : new C.PolylineDashMaterialProperty({
                color: tint.withAlpha(0.75),
                dashLength: 12,
              }),
          arcType: C.ArcType.NONE,
        },
      });
      // An AI's line to the problem has a dot running along it, towards it.
      if (l.strong)
        fl.packet = viewer.entities.add({
          position: new C.CallbackProperty(() => {
            const u = ((this.clock() + phase) % 3) / 3;
            return fl.curve[Math.round(u * (fl.curve.length - 1))];
          }, false) as unknown as CesiumNS.PositionProperty,
          point: {
            pixelSize: 6,
            color: C.Color.WHITE,
            outlineColor: tint,
            outlineWidth: 2,
          },
        });
      this.focusLines.push(fl);
    }
    this.applyShown();
  }

  /** Real AIs, or the invented cast of the concept view. */
  setSimMode(on: boolean) {
    this.simMode = on;
    this.applyShown();
  }

  /** Whether a thing is on the globe at the moment being shown. */
  present(c: Contact) {
    return (
      this.horizon === null ||
      (c.type !== 'QKE' && c.type !== 'EVT') ||
      (c.at ?? 0) <= this.horizon
    );
  }

  /**
   * One action chain, drawn hop by hop from where it started to the problem.
   * Hops that have happened are bright with a dot running along them; the
   * ones still to come are faint.
   */
  setChain(
    chain: {
      stops: { name: string; lat: number; lon: number; done: boolean }[];
      to: string;
      arrived: boolean;
    } | null,
  ) {
    const { C, viewer } = this;
    for (const e of this.chainEntities) viewer.entities.remove(e);
    this.chainEntities = [];
    const end = chain ? this.pos.get(chain.to) : undefined;
    if (!chain || !end) return;
    const points = chain.stops.map((st) =>
      C.Cartesian3.fromDegrees(st.lon, st.lat, 20_000),
    );
    const travelled: CesiumNS.Cartesian3[] = [];
    const hops = [...points, end];
    for (let i = 0; i + 1 < hops.length; i += 1) {
      const next = chain.stops[i + 1];
      const done = next ? next.done : chain.arrived;
      const curve = this.arc(hops[i], hops[i + 1]);
      if (done) travelled.push(...curve);
      this.chainEntities.push(
        viewer.entities.add({
          polyline: {
            positions: curve,
            width: done ? 4 : 2,
            material: done
              ? new C.PolylineGlowMaterialProperty({
                  glowPower: 0.25,
                  color: C.Color.WHITE.withAlpha(0.95),
                })
              : new C.PolylineDashMaterialProperty({
                  color: C.Color.WHITE.withAlpha(0.45),
                  dashLength: 14,
                }),
            arcType: C.ArcType.NONE,
          },
        }),
      );
    }
    chain.stops.forEach((st, i) => {
      this.chainEntities.push(
        viewer.entities.add({
          position: points[i],
          point: {
            pixelSize: 9,
            color: C.Color.WHITE,
            outlineColor: C.Color.BLACK,
            outlineWidth: 1.5,
          },
          label: {
            text: `${i + 1}. ${st.name}`,
            font: '600 12px "JetBrains Mono", monospace',
            fillColor: C.Color.WHITE,
            showBackground: true,
            backgroundColor:
              C.Color.fromCssColorString('#04121c').withAlpha(0.85),
            backgroundPadding: new C.Cartesian2(6, 4),
            pixelOffset: new C.Cartesian2(12, -12),
            horizontalOrigin: C.HorizontalOrigin.LEFT,
          },
        }),
      );
    });
    if (travelled.length > 1) {
      this.chainEntities.push(
        viewer.entities.add({
          position: new C.CallbackProperty(() => {
            const u = (this.clock() % 4) / 4;
            return travelled[Math.round(u * (travelled.length - 1))];
          }, false) as unknown as CesiumNS.PositionProperty,
          point: {
            pixelSize: 11,
            color: C.Color.fromCssColorString('#ffd84d'),
            outlineColor: C.Color.WHITE,
            outlineWidth: 2,
          },
        }),
      );
    }
  }

  /** The systems, busiest first: the roster. */
  roster() {
    return [...this.contacts.values()]
      .filter((c) => c.tier === 'uain' && !!c.sim === this.simMode)
      .sort((a, b) => b.weight - a.weight);
  }

  recentEvents() {
    return this.events;
  }

  placedCentre() {
    const placed = this.places.filter(
      (p) => p.placed && p.region === 'as-maritime',
    );
    if (!placed.length) return { lon: 112, lat: -2.5 };
    return {
      lon: placed.reduce((s, p) => s + (p.lon ?? 0), 0) / placed.length,
      lat: placed.reduce((s, p) => s + (p.lat ?? 0), 0) / placed.length,
    };
  }
}

interface GeoFeature {
  type: 'Feature';
  properties: { name: string };
  geometry: unknown;
}
