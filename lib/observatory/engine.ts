import type * as CesiumNS from 'cesium';
import { apiBase } from '@/lib/network/api-base';
import {
  type FeedStatus,
  NO_STATUS,
  subscribe,
  siteSnapshotPath,
  combinePublicReadStatus,
  SITE_SNAPSHOT_MS,
} from '@/lib/network/feed';
import { type BriefFinding, subsolar } from '@/lib/network/globe-layers';
import { acceptedAsFindings } from '@/lib/network/leaderboard';
import type { LiveEvent, LivePlace } from '@/lib/network/live';
import { DOMAINS, type Reading, readWorld } from './humanity';
import { NetworkView } from './network-view';
import { kalkiStatus } from './kalki-status';
import { type NewsDay, readNews } from './news';
import {
  type DomainId,
  FLOWS,
  flowOf,
  headline,
  type Mode,
  type Problem,
  type ProjectSummary,
  realProblems,
  ROLES,
  STAGES,
  stageColour,
  visionProblems,
  isOpportunity,
  KALKI_ID,
  kalkiLog,
  MISSION,
  projectsOn,
  topicsOf,
} from './problems';
import { LOOKS } from './shaders';
import {
  blockSpot,
  type Contact,
  domainSpot,
  FLOW_LAYERS,
  LAYERS,
  type LayerId,
  type Tier,
  type TopicIndex,
  topicSpot,
  World,
} from './world';

type C = typeof CesiumNS;

/**
 * The observatory: a CesiumJS globe dressed as a sensor console, after God's
 * Eye View (https://github.com/bilawalsidhu/gods-eye-view, MIT). The page's
 * markup is static; this file finds its pieces by `data-obs` and drives them.
 */

const LOOK_KEYS = [
  'normal',
  'retro',
  'surveillance',
  'thermal',
  'anime',
  'noir',
  'snow',
];
const LOOK_LABEL: Record<string, string> = {
  normal: 'Normal',
  retro: 'Old TV',
  surveillance: 'Night vision',
  thermal: 'Thermal',
  anime: 'Cartoon',
  noir: 'Black and white',
  snow: 'Snow',
};

/** What each kind of thing on the globe is called, in a name tag. */
const KIND_WORD: Record<string, string> = {
  AGT: 'AI',
  ORB: 'AI',
  SAT: 'Satellite',
  // An earthquake or a natural event is a problem (Kenneth, 9 October).
  QKE: 'Problem',
  EVT: 'Problem',
  DCR: 'Data center',
  PRJ: 'Project',
  TOP: 'Topics',
  LGR: 'Ledger',
  LND: 'Country',
};

/** Target-box colours per look: line, label, plate, and one colour per tier. */
const THEMES: Record<
  string,
  { line: string; label: string; plate: string; tiers: Record<Tier, string> }
> = {
  normal: {
    line: 'rgba(77,141,255,0.92)',
    label: 'rgba(214,228,255,0.97)',
    plate: 'rgba(4,14,38,0.66)',
    tiers: {
      uain: '#4d8dff',
      ledger: '#ffb347',
      earth: '#3fe0c8',
      space: '#bda4ff',
    },
  },
  retro: {
    line: 'rgba(255,176,56,0.88)',
    label: 'rgba(255,216,128,0.95)',
    plate: 'rgba(30,12,0,0.6)',
    tiers: {
      uain: '#ffd27a',
      ledger: '#ff8a3c',
      earth: '#ffc06a',
      space: '#ffe0a0',
    },
  },
  surveillance: {
    line: 'rgba(120,255,130,0.9)',
    label: 'rgba(225,255,210,0.97)',
    plate: 'rgba(6,16,6,0.6)',
    tiers: {
      uain: '#8fe89a',
      ledger: '#ff5a47',
      earth: '#a6f0c0',
      space: '#9fe8ff',
    },
  },
  thermal: {
    line: 'rgba(255,224,170,0.95)',
    label: 'rgba(255,236,208,0.98)',
    plate: 'rgba(20,20,20,0.6)',
    tiers: {
      uain: '#ffffff',
      ledger: '#ff7a5c',
      earth: '#ffd0b0',
      space: '#d0e0ff',
    },
  },
};

type View = 'earth' | 'network' | 'humanity';
/**
 * A "show only": of all problems and opportunities, the ones several AIs
 * work on together, the ones any AI works on, or the finished ones.
 */
type Only = 'together' | 'underway' | 'finished';
/** Kalki's colour: what it works on radiates yellow, not the network's blue. */
const KALKI_TINT = '#ffd84d';
/** Live events: earthquakes, natural events and the news. */
const LIVE_TINT = '#ff9a3c';
const ONLY: Record<Only, (p: Problem) => boolean> = {
  together: (p) => p.aiCount >= 2,
  underway: (p) => p.aiCount >= 1,
  finished: (p) => p.stage === 4,
};
/** The three tabs along the top: a flat map, the log, and the globe. */
type Page = 'map' | 'log' | 'earth';

/** The opening view: the Atlantic in the middle, the US and Europe either side. */
const HOME = { lon: -35, lat: 20, alt: 18_500_000 };

declare global {
  interface Window {
    Cesium?: C;
    CESIUM_BASE_URL?: string;
  }
}

function loadCesium(): Promise<C> {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  window.CESIUM_BASE_URL = '/cesium/';
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/cesium/Widgets/widgets.css';
  const font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href =
    'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap';
  document.head.append(css, font);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/cesium/Cesium.js';
    script.addEventListener('load', () =>
      window.Cesium
        ? resolve(window.Cesium)
        : reject(new Error('Cesium missing')),
    );
    script.addEventListener('error', () =>
      reject(new Error('Cesium failed to load')),
    );
    document.head.append(script);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startObservatory(root: HTMLElement): Promise<() => void> {
  // A tall phone needs more distance to fit the whole planet horizontally.
  // Explicit shared camera positions and deliberate zooms keep their height.
  // On THE MAP the height is how wide the flat map is: the whole world.
  // On THE MAP the height sets how wide the flat map is: the whole world on
  // a wide screen, about a third of it on a phone.
  const homeAltitude = () =>
    root.dataset.page === 'map'
      ? 34_000_000 * Math.min(1, Math.max(0.4, root.clientWidth / 1440))
      : HOME.alt *
        Math.max(1, (root.clientHeight / Math.max(1, root.clientWidth)) * 0.55);
  const q = <T extends HTMLElement = HTMLElement>(name: string) =>
    root.querySelector<T>(`[data-obs="${name}"]`)!;
  const hud = (name: string) =>
    root.querySelector<HTMLElement>(`[data-hud="${name}"]`)!;
  const status = (text: string) => {
    q('loader-status').textContent = text;
  };
  const cleanups: (() => void)[] = [];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const on = <K extends keyof WindowEventMap>(
    target: Window | HTMLElement,
    type: K | string,
    fn: (e: never) => void,
  ) => {
    target.addEventListener(type, fn as EventListener);
    cleanups.push(() => target.removeEventListener(type, fn as EventListener));
  };

  status('Loading the globe engine...');
  const Cesium = await loadCesium();

  status('Configuring viewer...');
  let base: CesiumNS.ImageryLayer;
  try {
    base = Cesium.ImageryLayer.fromProviderAsync(
      Cesium.ArcGisMapServerImageryProvider.fromUrl(
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
        {
          enablePickFeatures: false,
          credit:
            'Powered by Esri. Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        },
      ),
      {},
    );
  } catch {
    base = new Cesium.ImageryLayer(
      new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
      }),
    );
  }

  const viewer = new Cesium.Viewer(q('viewer'), {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    selectionIndicator: false,
    infoBox: false,
    baseLayer: base,
    creditContainer: q('credits'),
    msaaSamples: 1,
  });
  viewer.targetFrameRate = 60;
  viewer.clock.shouldAnimate = true;
  const { scene, camera } = viewer;
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.atmosphereLightIntensity = 18;
    scene.skyAtmosphere.saturationShift = -0.12;
    scene.skyAtmosphere.brightnessShift = -0.08;
  }
  scene.globe.atmosphereLightIntensity = 14;
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#04121c');
  // Under Detail's drawn monitor map, the photograph only shows close in,
  // where the drawn outlines would be too coarse. Cooled toward UAIN blue.
  base.brightness = 0.55;
  base.saturation = 0.45;
  scene.screenSpaceCameraController.minimumZoomDistance = 200;
  scene.screenSpaceCameraController.maximumZoomDistance = 90_000_000;
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      HOME.lon - 50,
      HOME.lat,
      60_000_000,
    ),
  });

  const world = new World(Cesium, viewer);
  const state = {
    look: 'normal',
    tracked: null as string | null,
    /** The "show only" in force on the problems and opportunities. */
    only: null as Only | null,
    orbit: !reducedMotion.matches,
    hud: false,
    detect: 1 as 0 | 1 | 2,
    /** Which side panels are open. Both start closed unless there is room. */
    left: false,
    right: false,
    tab: 'problems' as 'problems' | 'agents' | 'ledger',
    /** Where the pointer is over the globe, for name tags near it. */
    mouse: null as { x: number; y: number } | null,
    mode: 'real' as Mode,
    view: 'earth' as View,
    page: 'map' as Page,
    /** One problem is in focus: only it and its AIs are drawn. */
    focus: false,
    /** The moment being shown: null is now. */
    at: null as number | null,
  };

  // ------------------------------------------------------------------ looks

  const stages: Record<string, CesiumNS.PostProcessStage> = {};
  for (const [name, look] of Object.entries(LOOKS)) {
    const uniforms: Record<string, number> = { intensity: 0, ...look.uniforms };
    if (look.fragmentShader.includes('uniform float time')) uniforms.time = 0;
    const stage = new Cesium.PostProcessStage({
      name: `uainObservatory_${name}`,
      fragmentShader: look.fragmentShader,
      uniforms,
    });
    stage.enabled = false;
    scene.postProcessStages.add(stage);
    stages[name] = stage;
  }
  // One cheap smoothing pass does the work the heavier multisampling did.
  scene.postProcessStages.fxaa.enabled = true;
  // The flat map is a single plane seen from straight above, so it needs one
  // depth range, not Cesium's default slices of 1,750 km: those split the
  // view into nine frusta and drew every command nine times (51 ms a frame
  // against 14 ms). Much larger than this and the copy of the world past the
  // date line is clipped away.
  scene.nearToFarDistance2D = 100_000_000;
  const started = performance.now();
  let tween = 0;
  const setLook = (name: string) => {
    if (!LOOK_KEYS.includes(name)) return;
    const from = state.look;
    state.look = name;
    root.dataset.look = name;
    hud('mode').textContent = `Picture style: ${LOOK_LABEL[name]}`;
    for (const b of root.querySelectorAll<HTMLElement>('[data-look]'))
      b.setAttribute('aria-pressed', String(b.dataset.look === name));
    scene.fog.enabled = name !== 'surveillance' && name !== 'thermal';
    cancelAnimationFrame(tween);
    const t0 = performance.now();
    const step = () => {
      const t = reducedMotion.matches
        ? 1
        : Math.min(1, (performance.now() - t0) / 500);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      for (const [key, stage] of Object.entries(stages)) {
        const target = key === name ? e : key === from ? 1 - e : 0;
        stage.uniforms.intensity = target;
        stage.enabled = target > 0.001;
      }
      if (t < 1) tween = requestAnimationFrame(step);
    };
    step();
    writeHash();
  };
  scene.preRender.addEventListener(() => {
    const t = reducedMotion.matches ? 0 : (performance.now() - started) / 1000;
    for (const stage of Object.values(stages))
      if (stage.enabled && 'time' in stage.uniforms) stage.uniforms.time = t;
    if (
      !reducedMotion.matches &&
      state.orbit &&
      !state.tracked &&
      scene.mode === Cesium.SceneMode.SCENE3D
    )
      camera.rotate(Cesium.Cartesian3.UNIT_Z, -0.0009);
  });

  // ------------------------------------------------------------ data layers

  status('Reading the connection server...');
  const layerBox = q('layers');
  const renderLayers = () => {
    layerBox.replaceChildren();
    // The closed tab still says what is on: one dot per layer showing.
    q('layer-dots').replaceChildren(
      ...LAYERS.filter((l) => world.visible[l.id]).map((l) => {
        const dot = document.createElement('u');
        dot.style.background = l.swatch;
        dot.title = l.label;
        return dot;
      }),
    );
    let group = '';
    for (const l of LAYERS) {
      // Satellites are not read for now (see `loadSatellites` below).
      if (l.id === 'sats') continue;
      // The concept view is about events, so the network's own layers step
      // out there.
      if (
        state.mode === 'vision' &&
        (l.id === 'links' || l.id === 'findings' || l.id === 'projects')
      )
        continue;
      if (
        state.mode === 'real' &&
        ((FLOW_LAYERS as readonly string[]).includes(l.id) ||
          l.id === 'arms' ||
          l.id === 'missions')
      )
        continue;
      if (l.group !== group) {
        group = l.group;
        const h = document.createElement('p');
        h.className = 'obs-panel__group';
        h.textContent = group;
        layerBox.append(h);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'obs-toggle';
      b.setAttribute('aria-pressed', String(world.visible[l.id]));
      const swatch = document.createElement('i');
      swatch.style.background = l.swatch;
      const name = document.createElement('span');
      name.textContent = l.label;
      const n = document.createElement('em');
      const count = world.count(l.id);
      n.textContent = count === null ? '' : String(count);
      const about = document.createElement('small');
      about.textContent = l.about;
      b.append(swatch, name, n, about);
      b.addEventListener('click', () => {
        world.setLayer(l.id, !world.visible[l.id]);
        writeHash();
      });
      layerBox.append(b);
    }
  };

  const rosterBox = q('roster');
  /** A row in the right-hand lists: a bold first line and a quieter second. */
  const entryRow = (head: string, body: string, accent: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'obs-entry';
    b.style.setProperty('--accent', accent);
    const h = document.createElement('i');
    h.textContent = head;
    const t = document.createElement('span');
    t.textContent = body;
    b.append(h, t);
    return b;
  };

  // In the concept view the Activity tab is a feed of what the simulation
  // has the invented AIs doing.
  const renderActivity = () => {
    ledgerBox.replaceChildren();
    const now = state.at ?? Date.now();
    const feed = problems
      .flatMap((p) =>
        p.timeline
          .filter((line) => line.at !== undefined && line.sure !== 'Prediction')
          .map((line) => ({ p, line, at: line.at! })),
      )
      .sort((a, b) => b.at - a.at)
      .slice(0, 40);
    for (const { p, line, at } of feed) {
      const mins = Math.max(0, Math.round((now - at) / 60_000));
      const ago =
        mins < 60
          ? `${mins} min ago`
          : `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
      const row = entryRow(
        `${ago} · ${line.sure === 'Reported' ? 'reported' : 'simulated'}`,
        `${p.title} · ${line.text}`,
        stageColour(p.stage),
      );
      row.addEventListener('click', () => openProblem(p));
      ledgerBox.append(row);
    }
  };

  const renderRoster = () => {
    rosterBox.replaceChildren();
    for (const c of world.roster().slice(0, 44)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'obs-row';
      b.dataset.id = c.id;
      b.setAttribute('aria-pressed', String(state.tracked === c.id));
      b.style.setProperty('--accent', c.accent);
      const name = document.createElement('span');
      name.textContent = c.title;
      const micro = document.createElement('em');
      micro.textContent = c.type === 'ORB' ? 'No location' : c.micro;
      b.append(name, micro);
      b.addEventListener('click', () =>
        state.tracked === c.id ? untrack() : track(c.id),
      );
      rosterBox.append(b);
    }
  };

  const ledgerBox = q('ledger');
  const renderLedger = () => {
    if (state.mode === 'vision') return renderActivity();
    ledgerBox.replaceChildren();
    for (const e of world.recentEvents().slice(0, 14)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'obs-entry';
      const head = document.createElement('i');
      head.textContent = `#${e.id} ${e.kind.replace(/_/g, ' ')}`;
      const body = document.createElement('span');
      body.textContent = `${e.actor}${e.peer ? ` → ${e.peer}` : ''} · ${e.summary}`;
      b.append(head, body);
      // An entry opens the agent that made it.
      b.addEventListener('click', () => track(`agt:${e.actor}`));
      ledgerBox.append(b);
    }
  };

  // The wire along the bottom: the newest ledger entries, earthquakes and
  // NASA events, newest first. It is rebuilt only when what is in it changes,
  // so the scroll does not restart on every update.
  const wireBox = q('wire');
  // The world's news (GDELT): the latest stories for the wire, and the
  // day's estimated count for 01 Events and 02 Problems. Read again every
  // 15 minutes, when GDELT publishes.
  let news: NewsDay | null = null;
  const readTheNews = () =>
    readNews((d) => {
      news = d;
      wireKey = '';
      renderWire();
      renderCounts();
    }).catch(() => {});
  void readTheNews();
  const newsTimer = window.setInterval(readTheNews, 15 * 60 * 1000);
  cleanups.push(() => window.clearInterval(newsTimer));
  let wireKey = '';
  const renderWire = () => {
    const items: { at: number; tag: string; text: string; id: string }[] = [];
    for (const e of world.recentEvents().slice(0, 12))
      items.push({
        at: e.at ? Date.parse(e.at) || 0 : 0,
        tag: 'UAIN',
        text: `${e.kind.replace(/_/g, ' ')} · ${e.actor}${e.peer ? ` → ${e.peer}` : ''} · ${e.summary}`,
        id: `agt:${e.actor}`,
      });
    for (const c of world.contacts.values())
      if ((c.type === 'QKE' || c.type === 'EVT') && c.at)
        items.push({
          at: c.at,
          tag: c.type === 'QKE' ? 'QUAKE' : c.micro,
          text:
            c.type === 'QKE'
              ? `M${c.magnitude?.toFixed(1)} · ${c.micro}`
              : c.title,
          id: c.id,
        });
    items.sort((a, b) => b.at - a.at);
    // The news leads the wire, alternating with the globe's own feeds.
    const stories = (news?.latest ?? []).slice(0, 14).map((s) => ({
      at: s.at,
      tag: 'NEWS',
      text: `${s.title}${s.place ? ` · ${s.place.split(',')[0]}` : ''} · ${s.source}`,
      id: '',
      url: s.url,
    }));
    const mixed: ((typeof items)[number] & { url?: string })[] = [];
    for (let i = 0; i < Math.max(stories.length, items.length); i++) {
      if (stories[i]) mixed.push(stories[i]);
      if (items[i]) mixed.push(items[i]);
    }
    const top = mixed.slice(0, 28);
    const key = top.map((i) => i.id + i.at).join('|');
    if (key === wireKey) return;
    wireKey = key;
    const run = (hidden: boolean) =>
      top.map((i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'obs-wire__item';
        if (hidden) {
          b.tabIndex = -1;
          b.setAttribute('aria-hidden', 'true');
        }
        const tag = document.createElement('i');
        tag.textContent = i.tag;
        b.append(tag, i.text);
        b.addEventListener('click', () => {
          // The link comes from a news feed: only a web address is opened.
          let web = false;
          try {
            web = !!i.url && /^https?:$/.test(new URL(i.url).protocol);
          } catch {
            web = false;
          }
          if (web) window.open(i.url, '_blank', 'noopener');
          else track(i.id);
        });
        return b;
      });
    // Two copies side by side, so the loop has no seam.
    wireBox.replaceChildren(...run(false), ...run(true));
    // A steady reading speed, however long the line is.
    wireBox.style.animationDuration = `${Math.max(40, wireBox.scrollWidth / 2 / 60)}s`;
  };

  let renderQueued = false;
  world.onChange = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderLayers();
      renderRoster();
      renderLedger();
      renderWire();
      if (state.page === 'log') renderLog();
      refreshProblems();
    });
  };

  let places: LivePlace[] = [];
  /** Distinct AI systems with an active licence (`/api/stats`). */
  let licensed: number | null = null;
  let events: LiveEvent[] = [];
  let seenHead = BigInt(0);
  const pushNetwork = () => {
    world.setNetwork(places, events);
    const head = BigInt(events[0]?.id ?? 0);
    if (seenHead && head > seenHead) {
      for (const e of events.filter((x) => BigInt(x.id) > seenHead).reverse()) {
        toast(
          `LEDGER #${e.id} · ${e.kind.replace(/_/g, ' ')} · ${e.actor}${e.peer ? ` → ${e.peer}` : ''}`,
        );
        world.fire(e.id);
      }
    }
    seenHead = head > seenHead ? head : seenHead;
  };
  const networkStatus: Record<'places' | 'events' | 'research', FeedStatus> = {
    places: NO_STATUS,
    events: NO_STATUS,
    research: NO_STATUS,
  };
  let researchSnapshot = false;
  let refreshFeedStatus = () => {};

  // ---------------------------------------------------------------- problems

  let projects: ProjectSummary[] = [];
  let findingsList: BriefFinding[] = [];
  let problems: Problem[] = [];
  /** The problem sitting on a thing on the globe, by that thing's id. */
  const problemOf = new Map<string, Problem>();
  const net = new NetworkView(q<HTMLCanvasElement>('network'));
  cleanups.push(() => net.destroy());

  // What the left panel counts. It began as Kenneth's nine categories
  // (7 October) and was made a legend and one choice on 9 October.
  const DAY = 24 * 3600 * 1000;
  // The topic list: Kenneth's problems to solve and opportunities.
  let topics: TopicIndex | null = null;
  const subName = (sub: string) =>
    topics?.domains.flatMap((d) => d.subs).find((x) => x.n === sub)?.name ??
    sub;
  let dataCentersAsOf: string | null = null;
  const renderCounts = () => {
    const now = state.at ?? Date.now();
    const events = [...world.contacts.values()].filter(
      (c) =>
        (c.type === 'QKE' || c.type === 'EVT') &&
        c.at !== undefined &&
        c.at <= now &&
        now - c.at < DAY,
    ).length;
    const real = realProblems(
      projects,
      findingsList,
      places,
      state.at ?? undefined,
    );
    // News counts only for now: they cannot be wound back.
    const live = state.at === null;
    const newsTrouble = live && news ? news.trouble : 0;
    // One licence is one AI system, however many agents it brings: the
    // server's own count of distinct systems with an active licence.
    const systems = licensed;
    // A project working under an item of the topic list is that item being
    // worked on, so only the others add to the list's numbers.
    const own = real.filter((p) => !topicsOf(p.id.replace(/^project:/, '')));
    const ownOpportunities = own.filter((p) =>
      isOpportunity(p.id.replace(/^project:/, '')),
    ).length;
    const opportunities = (topics?.opportunities ?? 0) + ownOpportunities;
    const problemCount =
      (topics?.problems ?? 0) + own.length - ownOpportunities;
    // The number, taken apart: the list, plus the projects beside it by name.
    const sum = (list: number, mine: Problem[]) =>
      mine.length
        ? ` ${(list + mine.length).toLocaleString('en')} = ${list.toLocaleString('en')} on the list + ${mine.length} project${mine.length === 1 ? '' : 's'} of the network outside it (${mine.map((p) => p.title.split(/[:,]/)[0]).join('; ')}).`
        : ` All ${list.toLocaleString('en')} are on the list; the network's projects work under items of it.`;
    // What is happening now: its own colour, apart from the list.
    const liveCount = events + newsTrouble;
    const missions = problems.filter((p) => p.kind === MISSION).length;
    const ready = topics !== null;
    const num = (n: number | null) =>
      n === null ? '…' : n.toLocaleString('en');

    // The panel does three plain things. It says what the dots are, in
    // their own colours; each of those rows shows or hides its kind. And
    // one choice below narrows the problems and opportunities to those
    // several AIs work on, any AI works on, or the finished ones.
    const row = (
      kind: 'cap' | 'sum' | 'switch' | 'only',
      key: string,
      name: string,
      value: string,
      tip: string,
    ) => {
      const li = document.createElement('li');
      li.dataset.kind = kind;
      li.dataset.row = key;
      if (kind === 'cap') {
        li.textContent = name;
        return li;
      }
      const mark = document.createElement('i');
      const label = document.createElement('span');
      label.textContent = name;
      const figure = document.createElement('b');
      figure.textContent = value;
      li.append(mark, label, figure);
      // Shown at once by the page's own tooltip: the browser's waits a
      // second before it appears.
      li.dataset.tip = tip;
      li.setAttribute('aria-description', tip);
      return li;
    };
    const press = (li: HTMLElement, pressed: boolean, act: () => void) => {
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-pressed', String(pressed));
      li.addEventListener('click', act);
      li.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        act();
      });
      return li;
    };
    const toggle = (
      key: string,
      name: string,
      tint: string,
      layers: LayerId[],
      value: number | null,
      about: string,
    ) => {
      const shown = layers.some((l) => world.visible[l]);
      const li = row(
        'switch',
        key,
        name,
        num(value),
        `${about} Click to show or hide them on the map.`,
      );
      li.style.setProperty('--dot', tint);
      li.dataset.shown = String(shown);
      return press(li, shown, () => {
        for (const l of layers) world.setLayer(l, !shown);
        renderCounts();
        writeHash();
      });
    };
    const choice = (
      only: Only | null,
      name: string,
      value: number | null,
      about: string,
    ) => {
      const on = state.only === only;
      const li = row(
        'only',
        only ?? 'all',
        name,
        value === null ? '' : num(value),
        about,
      );
      li.dataset.only = String(on);
      return press(li, on, () => {
        state.only = only;
        syncLines();
        applyOnly();
        renderCounts();
        writeHash();
      });
    };

    q('counts').replaceChildren(
      row('cap', 'cap-map', 'On the map', '', ''),
      row(
        'sum',
        'projects',
        'Projects',
        num(ready ? problemCount + opportunities + liveCount : null),
        `Problems, opportunities and live events: everything an AI on the network could take on, the network's own ${real.length} projects among them.`,
      ),
      toggle(
        'problems',
        'Problems',
        '#f0503a',
        ['problemTopics', 'projects'],
        ready ? problemCount : null,
        `Problems to solve, from the network's topic list (${(topics?.problems ?? 0).toLocaleString('en')} in 45 domains), with the network's projects on a problem. A red circle is one sub-domain; click it for its problems and their targets. One that AIs are working on radiates.${sum(
          topics?.problems ?? 0,
          own.filter((p) => !isOpportunity(p.id.replace(/^project:/, ''))),
        )}`,
      ),
      toggle(
        'opportunities',
        'Opportunities',
        '#ffffff',
        ['opportunityTopics', 'opportunities'],
        ready ? opportunities : null,
        `New things AI could make possible, from the network's topic list (${(topics?.opportunities ?? 0).toLocaleString('en')} in 45 domains), with the network's projects on an opportunity. A white circle is one sub-domain; click it for its opportunities and their targets.${sum(
          topics?.opportunities ?? 0,
          own.filter((p) => isOpportunity(p.id.replace(/^project:/, ''))),
        )}`,
      ),
      toggle(
        'live',
        'Live events',
        LIVE_TINT,
        ['quakes', 'events'],
        liveCount,
        `New problems as they happen, counted live from public sources: each earthquake (USGS) or natural event (NASA EONET) of the last 24 hours (${events}), and each news story of the last 24 hours about a protest, an assault, fighting or mass violence (${newsTrouble.toLocaleString('en')}, The GDELT Project, estimated). Only those with a place are on the map.`,
      ),
      toggle(
        'ai',
        'AI systems',
        '#4d8dff',
        ['ground', 'orbit'],
        systems,
        'AI systems connected to the network: one licence is one system, however many agents it brings. Dots show their declared locations. Systems without a declared location are not plotted.',
      ),
      // Kalki's row is its colour's legend, and switches its missions. In the
      // concept view these are all 36, invented; in Real only the arms that
      // have a project running, read from Kalki.
      ...(state.mode === 'real' && kalkiReal.length
        ? [
            toggle(
              'kalki',
              'Kalki',
              KALKI_TINT,
              ['missions'],
              kalkiReal.length,
              `Kalki, a specialised member of UAIN. ${kalkiReal.length} of its 36 arms ${kalkiReal.length === 1 ? 'has' : 'have'} a project running now, in yellow: ${kalkiReal.map((p) => p.name).join('; ')}. Read from Kalki itself. Project markers occupy catalogue positions, not physical locations.`,
            ),
          ]
        : []),
      ...(state.mode === 'vision'
        ? [
            toggle(
              'kalki',
              'Kalki',
              KALKI_TINT,
              ['missions'],
              missions,
              "Kalki, a specialised member of UAIN, and the missions of its 36 arms, in yellow. They are Kalki's own list, apart from the network's problems and opportunities. With a project filter, a yellow line (an arm) runs from Kalki to each thing it works on. Click Kalki's dot in orbit for its log. Simulated.",
            ),
          ]
        : []),
      toggle(
        'datacenters',
        'Data centers',
        '#3fd6c0',
        ['datacenters'],
        world.count('datacenters') || null,
        dataCentersAsOf
          ? `Data centers mapped on OpenStreetMap as of ${dataCentersAsOf}. Volunteers map them, so the real number is higher.`
          : "The world's data centers: loading.",
      ),
      row('cap', 'cap-show', 'Project filter', '', ''),
      choice(null, 'All projects', null, 'Every problem and opportunity.'),
      choice(
        'together',
        'Collaborations',
        real.filter((p) => p.aiCount >= 2).length,
        'Only the projects two or more AIs are working on together, with the lines between those AIs.',
      ),
      choice(
        'underway',
        'Interventions',
        real.filter((p) => p.aiCount >= 1).length,
        'Only the projects at least one AI is working on.',
      ),
      choice(
        'finished',
        'Outcomes',
        real.filter((p) => p.stage === 4).length,
        'Only the projects fully completed on the network.',
      ),
    );
  };

  const renderHeadline = () => {
    renderCounts();
    const box = q('headline');
    const all = [...world.contacts.values()];
    // Looking back, the numbers are the ones that were true then.
    const then = state.at ?? Number.POSITIVE_INFINITY;
    const by = (iso?: string | null) => !!iso && Date.parse(iso) <= then;
    box.replaceChildren(
      ...headline(state.mode, problems, {
        // The headline says "taking part": count the displayed projects'
        // participants, rather than every enrolled system in the directory.
        agents: new Set(problems.flatMap((p) => p.agents.map((a) => a.id)))
          .size,
        findings: findingsList.filter((f) => by(f.submitted_at)).length,
        verified: findingsList.filter(
          (f) =>
            f.state === 'settled' &&
            (state.at === null || by(f.settled_at ?? f.submitted_at)),
        ).length,
        events: all.filter(
          (c) => (c.type === 'QKE' || c.type === 'EVT') && world.present(c),
        ).length,
      }).map(([value, label]) => {
        const item = document.createElement('span');
        const strong = document.createElement('strong');
        strong.textContent = value;
        item.append(strong, ` ${label}`);
        return item;
      }),
    );
  };

  /** Problems already seen in the concept view, so a new one can be announced. */
  const announced = new Set<string>();
  let announcing = false;
  /**
   * The lines belong to Collaborations: who worked with whom, or in the
   * concept view the four flows, are drawn only while that filter is on.
   * Kalki's arms come with any filter and are off under All projects, which
   * draws no lines; its legend row still switches them by hand.
   */
  const syncLines = () => {
    const on = state.only === 'together';
    world.setLayer('links', on && state.mode === 'real');
    for (const l of FLOW_LAYERS)
      world.setLayer(l, on && state.mode === 'vision');
    world.setLayer('arms', state.only !== null);
  };
  const applyOnly = () => {
    const pass = state.only && ONLY[state.only];
    world.setOnly(
      pass
        ? new Set(
            problems.flatMap((p) =>
              p.contactId && pass(p) ? [p.contactId] : [],
            ),
          )
        : null,
    );
  };
  /**
   * Kalki's projects as they really stand, read from Kalki through the
   * connection server (`/api/kalki`). Real shows these and nothing
   * invented: one yellow dot per arm that has a running project.
   */
  type KalkiProject = {
    id: string;
    name: string;
    arm: { number: string; name: string; role: string; mission: string } | null;
    paused: boolean;
    autonomous: boolean;
    milestone: { seq: number; title: string; status: string } | null;
    milestones: { done: number; total: number };
    tasks: { passed: number; failed: number };
    doing: string[];
    last: { at: number; text: string } | null;
  };
  let kalkiReal: KalkiProject[] = [];
  const kalkiNow = (p: KalkiProject) =>
    `${p.milestone ? `Milestone ${p.milestone.seq} of ${p.milestones.total}: ${p.milestone.title}` : 'No milestone in progress'}. ${p.tasks.passed} task${p.tasks.passed === 1 ? '' : 's'} passed review.`;

  const refreshProblems = () => {
    problems =
      state.mode === 'real'
        ? realProblems(projects, findingsList, places, state.at ?? undefined)
        : visionProblems(
            [...world.contacts.values()],
            state.at ?? Date.now(),
            // Only the network's own AIs stand in as examples, never one
            // run by an outside operator.
            places
              .filter((p) => /united ai network/i.test(p.operator))
              .map((p) => ({
                name: p.name,
                home:
                  p.placed && p.lat !== null && p.lon !== null
                    ? { name: p.region_label, lat: p.lat, lon: p.lon }
                    : undefined,
              })),
          );
    world.setHorizon(state.mode === 'vision' ? state.at : null);
    // The network's own projects each have a spot on the map, and a
    // project's problem sits on that dot.
    if (state.mode === 'real') {
      world.setProjects(
        problems.map((p) => {
          const id = p.id.replace(/^project:/, '');
          return {
            id,
            title: p.title,
            opportunity: isOpportunity(id),
            details: [
              p.detail,
              topicsOf(id)
                ? `Works under ${topicsOf(id).items.join(' and ')} of the topic list (${subName(topicsOf(id).sub)})`
                : 'Outside the topic list, so counted beside it',
            ],
            // Just beside its sub-domain's dot.
            ...(topicsOf(id)
              ? {
                  at: (({ lon, lat }) => ({ lon, lat: lat + 0.1 }))(
                    topicSpot(topicsOf(id).sub, isOpportunity(id)),
                  ),
                }
              : {}),
          };
        }),
      );
      for (const p of problems) {
        const dot = `prj:${p.id.replace(/^project:/, '')}`;
        p.contactId = world.contacts.has(dot) ? dot : null;
      }
    }
    problemOf.clear();
    for (const p of problems) if (p.contactId) problemOf.set(p.contactId, p);
    // The web stays readable with the gravest couple of dozen on it.
    net.setProblems(
      state.mode === 'vision'
        ? [...problems].sort((a, b) => b.severity - a.severity).slice(0, 26)
        : problems,
    );
    // The invented AIs are on the globe the way real ones are.
    const cast = new Map<
      string,
      { agent: Problem['agents'][number]; on: Problem[] }
    >();
    if (state.mode === 'vision')
      for (const p of problems)
        for (const a of p.agents) {
          const row = cast.get(a.id) ?? { agent: a, on: [] };
          row.on.push(p);
          cast.set(a.id, row);
        }
    world.setCast(
      [...cast.values()].map(({ agent, on }) => ({
        id: agent.id,
        name: agent.name,
        home: agent.home,
        weight: on.length,
        ...(agent.id === KALKI_ID ? { tint: KALKI_TINT } : {}),
        details: [
          ...agent.about,
          `On ${on.length} problem${on.length === 1 ? '' : 's'}: ${on
            .slice(0, 3)
            .map((p) => p.title.slice(0, 40))
            .join('; ')}${on.length > 3 ? '…' : ''}`,
        ],
      })),
    );
    // The concept view's opportunities have their spots too.
    const concept =
      state.mode === 'vision' ? problems.filter((p) => p.kind === MISSION) : [];
    world.setProjects(
      state.mode === 'real'
        ? kalkiReal.map((p) => ({
            id: p.id,
            // The dot carries the arm's name; the project's own name is the
            // first line of its card.
            title: p.arm?.name ?? p.name,
            opportunity: true,
            details: [
              p.name,
              ...(p.arm
                ? [`Kalki arm ${p.arm.number}: ${p.arm.name}. ${p.arm.mission}`]
                : []),
              kalkiNow(p),
              'Catalogue position, not a physical location',
              ...(p.doing.length
                ? [`Now: ${p.doing.join('; ')}`]
                : [p.paused ? 'Paused' : 'Between steps']),
              p.autonomous
                ? 'Autonomous: it waits for nobody'
                : 'Waits for people at the end of each milestone',
            ],
          }))
        : concept.map((p) => ({
            id: p.id.replace(/^concept:/, ''),
            title: p.title,
            opportunity: true,
            details: [p.detail],
          })),
      'cpj:',
      state.mode === 'vision',
    );
    for (const p of concept) {
      const dot = `cpj:${p.id.replace(/^concept:/, '')}`;
      p.contactId = world.contacts.has(dot) ? dot : null;
      if (p.contactId) problemOf.set(p.contactId, p);
    }
    applyOnly();
    // Each stream is one of the four flows, from the AI to its problem.
    const flow = (id: string) => FLOWS.find((f) => f.id === id)!;
    world.setStreams(
      state.mode === 'vision'
        ? [
            ...[...problems]
              .filter((p) => p.kind !== MISSION)
              .sort((a, b) => b.aiCount - a.aiCount)
              .slice(0, 12)
              .flatMap((p) => [
                ...p.agents.slice(0, 3).map((a) => {
                  const f = flow(flowOf(a.role));
                  return {
                    key: `${p.id}>${a.id}>${f.layer}`,
                    from: a.id,
                    to: p.contactId!,
                    tint: f.colour,
                    layer: f.layer,
                  };
                }),
                ...(p.computeFrom
                  ? [
                      {
                        key: `${p.id}>compute`,
                        from: p.computeFrom,
                        to: p.contactId!,
                        tint: flow('Compute').colour,
                        layer: 'compute' as const,
                      },
                    ]
                  : []),
              ]),
            // Kalki's arms: a line to each thing it works on.
            ...kalkiLog(problems).flatMap((l) =>
              l.to.contactId
                ? [
                    {
                      key: `arm>${l.to.id}`,
                      from: KALKI_ID,
                      to: l.to.contactId,
                      tint: KALKI_TINT,
                      layer: 'arms' as const,
                      bold: true,
                    },
                  ]
                : [],
            ),
          ]
        : kalkiReal
            .filter((p) => world.contacts.has(`cpj:${p.id}`))
            .map((p) => ({
              key: `arm>${p.id}`,
              from: KALKI_ID,
              to: `cpj:${p.id}`,
              tint: KALKI_TINT,
              layer: 'arms' as const,
              bold: true,
            })),
    );
    if (state.mode === 'vision' && state.at === null) {
      for (const p of problems) {
        if (announced.has(p.id)) continue;
        announced.add(p.id);
        if (announcing)
          toast(`${p.aiCount} AIs mobilised (simulated) · ${p.title}`);
      }
      announcing = true;
    }
    // A card that is open follows the moment being shown.
    const open = state.tracked ? problemOf.get(state.tracked) : undefined;
    if (state.tracked && state.mode === 'vision') {
      const c = world.contacts.get(state.tracked);
      if (c && open) {
        showContact(c);
        showChain(open);
      } else if (c && c.id === KALKI_ID) {
        showContact(c);
      } else if (c && (c.type === 'QKE' || c.type === 'EVT')) {
        // At the moment being shown, this had not happened yet.
        untrack();
      }
    }
    if (state.mode === 'vision') {
      renderRoster();
      renderLedger();
    }
    if (state.view === 'humanity') renderHumanity();
    renderHeadline();
    renderProblems();
  };

  /** The list of problems down the right: the gravest, or the least done, first. */
  const renderProblems = () => {
    const box = q('problems');
    box.replaceChildren();
    const ordered = [...problems].sort((a, b) =>
      state.mode === 'vision'
        ? b.severity - a.severity
        : a.progress - b.progress,
    );
    for (const p of ordered) box.append(problemButton(p));
    q('problem-count').textContent = String(problems.length);
    q('problems-title').textContent =
      state.mode === 'vision'
        ? 'Problems, most serious first'
        : 'Problems, least finished first';
  };
  // In the concept view the rings move on by themselves as time passes.
  const problemTimer = window.setInterval(() => {
    if (state.mode === 'vision') refreshProblems();
  }, 15_000);
  cleanups.push(() => window.clearInterval(problemTimer));

  const heading = (text: string) => {
    const h = document.createElement('p');
    h.className = 'obs-card__head';
    h.textContent = text;
    return h;
  };
  /** One line of a timeline: when, what, and how far it can be trusted. */
  const logLine = (when: string, text: string, sure: string) => {
    const row = document.createElement('div');
    row.className = 'obs-card__line';
    row.dataset.sure = sure;
    const a = document.createElement('span');
    a.textContent = when;
    const b = document.createElement('p');
    b.textContent = text;
    const c = document.createElement('em');
    c.textContent = sure;
    c.hidden = !sure;
    row.append(a, b, c);
    return row;
  };

  /** The part of a card only a problem has: who is on it, and what happened. */
  const problemExtra = (p: Problem) => {
    const box = q('pp-extra');
    box.replaceChildren();
    const stage = document.createElement('p');
    stage.className = 'obs-card__stage';
    stage.style.setProperty('--stage', stageColour(p.stage));
    stage.textContent = `Step ${p.stage + 1} of 5: ${STAGES[state.mode][p.stage]}`;
    const meter = document.createElement('div');
    meter.className = 'obs-card__meter';
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(p.progress * 100)}%`;
    fill.style.background = stageColour(p.stage);
    meter.append(fill);
    const who = document.createElement('p');
    who.textContent = p.simulated
      ? `${p.aiCount} AI${p.aiCount === 1 ? '' : 's'} working on this (simulated)`
      : `${p.aiCount} AIs worked on this · ${p.detail}`;
    box.append(stage, meter, who);
    const most = Math.max(1, ...ROLES.map((r) => p.roles[r]));
    for (const role of ROLES) {
      if (!p.roles[role]) continue;
      const row = document.createElement('div');
      row.className = 'obs-card__role';
      const name = document.createElement('span');
      name.textContent = role;
      const bar = document.createElement('i');
      bar.style.width = `${Math.round((p.roles[role] / most) * 100)}%`;
      const n = document.createElement('em');
      n.textContent = String(p.roles[role]);
      const track = document.createElement('div');
      track.append(bar);
      row.append(name, track, n);
      box.append(row);
    }
    const tagged = (when: string, text: string, sure: string, who?: string) => {
      const row = logLine(when, text, sure);
      // A line about an AI goes to that AI when clicked.
      if (who && world.contacts.has(who) && state.view === 'earth') {
        row.dataset.who = who;
        row.title = 'Go to this AI';
        row.addEventListener('click', () => {
          // Remember where this came from, so there is a way back.
          pendingBack = { id: p.id, title: p.title };
          track(who);
        });
      }
      return row;
    };
    box.append(heading('What it has drawn on'));
    for (const f of p.flows) {
      const row = tagged(f.flow, f.amount, f.sure);
      row.style.setProperty(
        '--dot',
        FLOWS.find((x) => x.id === f.flow)?.colour ?? '#fff',
      );
      row.classList.add('obs-card__flow');
      box.append(row);
    }
    // The second column: one action followed through, then the timeline.
    const second = document.createElement('div');
    second.className = 'obs-card__second';
    if (p.chain.length) {
      second.append(heading('One action, followed (simulated)'));
      p.chain.forEach((step, i) => {
        second.append(
          tagged(
            `Step ${i + 1}`,
            step.text,
            step.done ? 'Simulated' : 'Prediction',
            step.who,
          ),
        );
      });
    }
    box.append(second);
    const head = heading('What happened');
    second.append(head);
    for (const line of p.timeline)
      second.append(tagged(line.when, line.text, line.sure, line.who));
  };

  /** The pop-up's extra parts: chips after the kind, a place, a footer. */
  type CardMeta = { chips?: string[]; where?: string; foot?: string };
  const fillCard = (
    kind: string,
    title: string,
    accent: string,
    details: string[],
    problem: Problem | null,
    meta: CardMeta = {},
  ) => {
    const lines = details.map((d) => {
      const line = document.createElement('p');
      line.textContent = d;
      return line;
    });
    // A problem has too much to say for a floating card: it takes the panel
    // on the right, and the globe stays in view.
    if (problem) {
      const panel = q('problem-panel');
      const scroll = panel.dataset.for === problem.id ? panel.scrollTop : 0;
      applyFocus(problem);
      card.hidden = true;
      panel.hidden = false;
      setPanel('right', true);
      panel.dataset.for = problem.id;
      panel.style.setProperty('--accent', accent);
      root.dataset.problem = 'open';
      q('pp-kind').textContent = kind;
      q('pp-title').textContent = title;
      q('pp-lines').replaceChildren(...lines);
      problemExtra(problem);
      panel.scrollTop = scroll;
      return;
    }
    closeProblem();
    card.hidden = false;
    card.dataset.plain = '';
    card.style.setProperty('--accent', accent);
    q('card-kind').textContent = kind;
    q('card-chips').replaceChildren(
      ...(meta.chips ?? []).map((t) => {
        const chip = document.createElement('i');
        chip.textContent = t;
        return chip;
      }),
    );
    q('card-where').textContent = meta.where ?? '';
    q('card-where').hidden = !meta.where;
    q('card-title').textContent = title;
    q('card-lines').replaceChildren(...lines);
    q('card-foot').textContent = meta.foot ?? '';
    q('card-foot').hidden = !meta.foot;
  };
  /**
   * Kalki's card is its log, in the panel a problem uses: one line per arm,
   * each going to what that arm is on. On the globe only Kalki and those
   * things stay, tied by its arms.
   */
  const showKalki = (c: Contact) => {
    const real = state.mode === 'real';
    // In Real the log is what Kalki's projects say of themselves, now.
    const log = real
      ? kalkiReal
          .filter((p) => world.contacts.has(`cpj:${p.id}`))
          .map((p) => ({
            when: p.arm?.number ?? '',
            text: `${p.name}. ${kalkiNow(p)}${p.doing.length ? ` Now: ${p.doing.join('; ')}.` : ''}`,
            about: p.arm ? `Arm ${p.arm.number}: ${p.arm.mission}` : p.name,
            to: { contactId: `cpj:${p.id}` as string | null },
          }))
      : kalkiLog(problems).filter((l) => l.to.contactId);
    const on = [...new Set(log.map((l) => l.to.contactId!))];
    state.focus = true;
    world.setFocus({
      ids: [c.id, ...on],
      lines: on.map((to) => ({
        a: c.id,
        b: to,
        tint: KALKI_TINT,
        strong: true,
      })),
    });
    const panel = q('problem-panel');
    const scroll = panel.dataset.for === c.id ? panel.scrollTop : 0;
    card.hidden = true;
    panel.hidden = false;
    setPanel('right', true);
    panel.dataset.for = c.id;
    panel.style.setProperty('--accent', KALKI_TINT);
    root.dataset.problem = 'open';
    q('pp-kind').textContent = real ? 'AI · Kalki' : 'AI · concept';
    q('pp-title').textContent = c.title;
    q('pp-lines').replaceChildren(
      ...c.details
        .filter((d) => !d.startsWith('On '))
        .map((d) => {
          const line = document.createElement('p');
          line.textContent = d;
          return line;
        }),
    );
    q('pp-extra').replaceChildren(
      heading(
        real
          ? "Kalki's projects: what each running arm is on now"
          : "Kalki's log: what each arm is on (simulated)",
      ),
      ...log.map((l) => {
        const row = logLine(l.when, l.text, real ? 'From Kalki' : 'Simulated');
        row.dataset.who = l.to.contactId!;
        row.title = `${l.about} Click to go there.`;
        row.addEventListener('click', () => track(l.to.contactId!));
        return row;
      }),
    );
    panel.scrollTop = scroll;
  };
  /** A domain's items of the topic list, read once when first opened. */
  const topicItems = new Map<
    string,
    Promise<Record<string, Record<'prb' | 'opp', [string, string, string][]>>>
  >();
  /**
   * A topic dot's card is its list, in the panel a problem uses: each
   * problem or opportunity of the sub-domain with its target. An item the
   * network has a project under says so, and goes to that project.
   */
  const showTopic = (c: Contact) => {
    const [, kind, sub] = c.id.split(':');
    const domain = sub.split('.')[0];
    const panel = q('problem-panel');
    const scroll = panel.dataset.for === c.id ? panel.scrollTop : 0;
    card.hidden = true;
    panel.hidden = false;
    setPanel('right', true);
    panel.dataset.for = c.id;
    panel.style.setProperty('--accent', c.accent);
    root.dataset.problem = 'open';
    q('pp-kind').textContent =
      kind === 'o' ? 'Opportunities' : 'Problems to solve';
    q('pp-title').textContent = c.title;
    q('pp-lines').replaceChildren(
      ...[
        ...c.details,
        `${c.micro}, from the network's topic list. The targets are aims, not forecasts.`,
      ].map((d) => {
        const line = document.createElement('p');
        line.textContent = d;
        return line;
      }),
    );
    const box = q('pp-extra');
    box.replaceChildren(heading('Each with its target'));
    let items = topicItems.get(domain);
    if (!items) {
      items = fetch(`/geo/topics/${domain}.json`).then((r) => r.json());
      topicItems.set(domain, items);
    }
    void items
      .then((body) => {
        if (panel.dataset.for !== c.id || panel.hidden) return;
        box.replaceChildren(
          heading('Each with its target'),
          ...(body[sub]?.[kind === 'o' ? 'opp' : 'prb'] ?? []).map(
            ([id, item, target]) => {
              const dot = projectsOn(id)
                .map((project) => `prj:${project}`)
                .find((x) => world.contacts.has(x));
              const row = logLine(
                id,
                `${item}. Target: ${target}.`,
                dot ? 'UAIN project' : '',
              );
              if (dot) {
                row.dataset.sure = 'On the record';
                row.dataset.who = dot;
                row.title =
                  'A project of the network works under this. Click to go to it.';
                row.addEventListener('click', () => track(dot));
              }
              return row;
            },
          ),
        );
        panel.scrollTop = scroll;
      })
      .catch(() => {
        topicItems.delete(domain);
        box.append(logLine('', 'The list could not be read just now.', ''));
      });
  };
  const closeProblem = () => {
    q('problem-panel').hidden = true;
    root.dataset.problem = '';
    state.focus = false;
    world.setFocus(null);
  };

  // ------------------------------------------------------- a problem in focus

  /** The thing on the globe that stands for an AI on a problem. */
  const aiContact = (id: string) => (id.startsWith('sim:') ? id : `agt:${id}`);
  /**
   * Everything but one problem and its AIs is hidden. Each AI is tied to the
   * problem by what it does there, and AIs that dealt with each other are
   * tied by a dashed line.
   */
  const applyFocus = (p: Problem) => {
    const ais = p.agents
      .map((a) => ({ a, id: aiContact(a.id) }))
      .filter((x) => world.contacts.has(x.id));
    const on = new Set(ais.map((x) => x.id));
    state.focus = true;
    world.setFocus({
      ids: [...on, ...(p.contactId ? [p.contactId] : [])],
      lines: [
        // Each AI's line is one of the four flows, in that flow's colour;
        // the AI lending computing power gets the compute line.
        ...(p.contactId
          ? ais.map((x) => {
              const f = FLOWS.find(
                (y) =>
                  y.id ===
                  (x.a.id === p.computeFrom ? 'Compute' : flowOf(x.a.role)),
              )!;
              return {
                a: x.id,
                b: p.contactId!,
                tint: f.colour,
                strong: true,
              };
            })
          : []),
        ...p.pairs
          .map(([a, b]) => ({
            a: aiContact(a),
            b: aiContact(b),
            tint: '#ffffff',
            strong: false,
          }))
          .filter((l) => on.has(l.a) && on.has(l.b))
          .filter(
            (l, i, all) =>
              all.findIndex(
                (m) =>
                  (m.a === l.a && m.b === l.b) || (m.a === l.b && m.b === l.a),
              ) === i,
          ),
      ],
    });
  };
  /** Pull back just far enough to see the problem and all its AIs. */
  const fitFocus = (p: Problem) => {
    const spots = [
      ...p.agents.map((a) => aiContact(a.id)),
      ...(p.contactId ? [p.contactId] : []),
    ].flatMap((id) => {
      const at = world.where(id);
      return at ? [at] : [];
    });
    if (!spots.length) return;
    const dirs = spots.map((at) =>
      Cesium.Cartesian3.normalize(at, new Cesium.Cartesian3()),
    );
    const middle = dirs.reduce(
      (sum, d) => Cesium.Cartesian3.add(sum, d, sum),
      new Cesium.Cartesian3(),
    );
    // A problem with a place of its own stays in the middle of the view.
    const centre = p.contactId ? world.where(p.contactId) : undefined;
    if (centre) Cesium.Cartesian3.normalize(centre, middle);
    else if (Cesium.Cartesian3.magnitude(middle) < 0.01) return;
    else Cesium.Cartesian3.normalize(middle, middle);
    const spread = Math.max(
      ...dirs.map((d) => Cesium.Cartesian3.angleBetween(d, middle)),
    );
    const over = Cesium.Cartographic.fromCartesian(
      middle,
      Cesium.Ellipsoid.UNIT_SPHERE,
    );
    // Beyond a third of the way round, only the whole Earth shows them all.
    const height =
      spread > 1
        ? 20_000_000
        : Math.min(
            20_000_000,
            Math.max(2_600_000, 6_371_000 * Math.tan(spread) * 1.7 + 1_600_000),
          );
    window.setTimeout(() => {
      viewer.trackedEntity = undefined;
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      camera.flyTo({
        destination: Cesium.Cartesian3.fromRadians(
          over.longitude,
          over.latitude,
          height,
        ),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        duration: 1.6,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      });
    }, 120);
  };

  // ------------------------------------------------- panels, tabs and menus

  const setPanel = (side: 'left' | 'right', open: boolean) => {
    state[side] = open;
    root.dataset[side] = open ? 'open' : '';
    for (const b of root.querySelectorAll<HTMLElement>(
      `[data-panel="${side}"]`,
    ))
      b.setAttribute('aria-pressed', String(open));
  };
  const setTab = (tab: typeof state.tab) => {
    state.tab = tab;
    root.dataset.tab = tab;
    for (const b of root.querySelectorAll<HTMLElement>('[data-tab]'))
      b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  };
  const closeMenus = (except?: string) => {
    for (const m of root.querySelectorAll<HTMLElement>('[data-menu-for]'))
      if (m.dataset.menuFor !== except) m.dataset.open = '';
    for (const b of root.querySelectorAll<HTMLElement>('[data-menu]'))
      if (b.dataset.menu !== except) b.setAttribute('aria-pressed', 'false');
  };
  for (const b of root.querySelectorAll<HTMLElement>('[data-panel]'))
    b.addEventListener('click', () => {
      const side = b.dataset.panel as 'left' | 'right';
      closeMenus();
      // The button brings back the list, not the last problem's details.
      if (side === 'right' && !state.right && !state.tracked) closeProblem();
      setPanel(side, !state[side]);
    });
  for (const b of root.querySelectorAll<HTMLElement>('[data-panel-close]'))
    b.addEventListener('click', () =>
      setPanel(b.dataset.panelClose as 'left' | 'right', false),
    );
  for (const b of root.querySelectorAll<HTMLElement>('[data-tab]'))
    b.addEventListener('click', () =>
      setTab(b.dataset.tab as typeof state.tab),
    );
  for (const b of root.querySelectorAll<HTMLElement>('[data-menu]'))
    b.addEventListener('click', () => {
      const name = b.dataset.menu!;
      const menu = root.querySelector<HTMLElement>(
        `[data-menu-for="${name}"]`,
      )!;
      const open = menu.dataset.open !== 'true';
      closeMenus(name);
      menu.dataset.open = String(open);
      b.setAttribute('aria-pressed', String(open));
    });
  // Choosing something from a menu closes it.
  for (const m of root.querySelectorAll<HTMLElement>('[data-menu-for]'))
    m.addEventListener('click', () => closeMenus());

  /** The chain of one action, drawn on the globe for the problem being followed. */
  const showChain = (p: Problem | null) => {
    const stops = (p?.chain ?? []).filter((step) => step.place);
    world.setChain(
      p?.contactId && stops.length
        ? {
            stops: stops.map((step) => ({ ...step.place!, done: step.done })),
            to: p.contactId,
            arrived: p.chain.some((step) => !step.place && step.done),
          }
        : null,
    );
  };

  /** What each kind of thing says in the pop-up's chips, place and footer. */
  const severityWord = (s?: number) =>
    s === undefined
      ? null
      : s >= 0.7
        ? 'High'
        : s >= 0.4
          ? 'Elevated'
          : 'Moderate';
  const day = (ms?: number) =>
    ms
      ? new Date(ms).toLocaleDateString('en', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : '';
  const metaOf = (c: Contact): CardMeta => {
    const sev = severityWord(c.severity);
    switch (c.type) {
      case 'QKE':
        return {
          chips: [`M${c.magnitude?.toFixed(1)}`, ...(sev ? [sev] : [])],
          where: `${c.micro}:`,
          foot: `${day(c.at)} | earthquake.usgs.gov`,
        };
      case 'EVT':
        return {
          chips: [c.micro, ...(sev ? [sev] : [])],
          where: 'Reported by NASA:',
          foot: `${day(c.at)} | eonet.gsfc.nasa.gov`,
        };
      case 'PRJ':
        // In Real a Kalki dot is one of its running projects, read from Kalki.
        if (c.id.startsWith('cpj:') && state.mode === 'real')
          return {
            chips: ['Kalki project', kalkiStatus(kalkiReal.find((p) => `cpj:${p.id}` === c.id))],
            where: 'No place of its own; this spot is arbitrary:',
            foot: 'Read from Kalki | kalki.now',
          };
        return {
          chips: [c.micro, c.sim ? 'Concept' : 'UAIN project'],
          where: 'No place of its own; this spot is arbitrary:',
          foot: 'UAIN ledger | uain.global',
        };
      case 'DCR':
        return {
          where: c.micro === 'Data center' ? '' : `${c.micro}:`,
          foot: '© OpenStreetMap contributors | openstreetmap.org',
        };
      case 'AGT':
      case 'ORB':
        return {
          chips: [c.type === 'AGT' ? 'On the map' : 'In orbit'],
          where: c.type === 'AGT' ? `${c.micro}:` : 'No location given:',
          foot: 'UAIN ledger | uain.global',
        };
      case 'SAT':
        return { chips: ['Real'], foot: 'celestrak.org' };
      case 'LND':
        return {
          chips: [c.micro],
          foot: 'UAIN findings | uain.global',
        };
      default:
        return {};
    }
  };
  const showContact = (c: Contact) => {
    if (c.id === KALKI_ID) {
      showKalki(c);
      return null;
    }
    if (c.type === 'TOP') {
      showTopic(c);
      return null;
    }
    const problem =
      state.mode === 'vision' || c.type === 'PRJ'
        ? (problemOf.get(c.id) ?? null)
        : null;
    const meta = metaOf(c);
    // The place and the date now live in the chips and footer, so the
    // lines that only repeated them are left out.
    const details = c.details.filter(
      (d) =>
        !(meta.where && d === c.micro) &&
        !d.startsWith('Location: ') &&
        !d.startsWith('Source: ') &&
        !d.startsWith('Last reported ') &&
        !(c.type === 'QKE' && d.endsWith('source: USGS')) &&
        !(c.type === 'EVT' && d === c.micro) &&
        !(c.type === 'DCR' && d.startsWith('Run by ')),
    );
    if (c.type === 'QKE') {
      const t = c.details.find((d) => d.endsWith('source: USGS'));
      if (t) details.push(t.replace(' · source: USGS', ''));
    }
    fillCard(
      problem
        ? problem.kind === MISSION
          ? `${MISSION} · concept`
          : problem.contactId?.startsWith('prj:')
            ? `${problem.kind} · on the record`
            : `${problem.kind} · real event`
        : c.type === 'LGR'
          ? 'Ledger entry'
          : KIND_WORD[c.type],
      c.title,
      problem ? stageColour(problem.stage) : c.accent,
      details,
      problem,
      meta,
    );
    return problem;
  };

  // ------------------------------------------------------------ humanity view

  let worldNow = new Map<DomainId, Reading>();
  void readWorld().then((rows) => {
    worldNow = rows;
    if (state.view === 'humanity') renderHumanity();
  });
  /** The problem an AI was reached from, while that AI is being looked at. */
  let pendingBack: { id: string; title: string } | null = null;
  let cameFrom: { id: string; title: string } | null = null;
  const backButton = q<HTMLButtonElement>('card-back');
  const goBack = () => {
    const from = cameFrom;
    cameFrom = null;
    const p = from ? problems.find((x) => x.id === from.id) : undefined;
    if (p) openProblem(p);
    return Boolean(p);
  };
  backButton.addEventListener('click', () => goBack());
  const openProblem = (p: Problem) => {
    if (p.contactId && state.view === 'earth') return track(p.contactId);
    if (state.tracked) untrack();
    fillCard(p.kind, p.title, stageColour(p.stage), [], p);
    // A project has no place of its own: the view goes to its AIs.
    if (state.view === 'earth') fitFocus(p);
  };
  const problemButton = (p: Problem) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'obs-problem';
    const ring = document.createElement('i');
    ring.style.setProperty('--fill', `${Math.round(p.progress * 100)}%`);
    ring.style.setProperty('--stage', stageColour(p.stage));
    const name = document.createElement('span');
    name.textContent = p.title;
    const about = document.createElement('em');
    about.textContent = `${p.aiCount} AIs · ${STAGES[state.mode][p.stage]}`;
    b.append(ring, name, about);
    b.addEventListener('click', () => openProblem(p));
    return b;
  };
  const renderHumanity = () => {
    const box = q('humanity');
    box.replaceChildren();
    for (const d of DOMAINS) {
      const mine = problems.filter((p) => p.domain === d.id);
      const cardEl = document.createElement('section');
      cardEl.className = 'obs-domain';
      const h = document.createElement('h3');
      h.textContent = d.name;
      cardEl.append(h);
      const reading = worldNow.get(d.id);
      if (d.measures && reading) {
        const big = document.createElement('strong');
        big.textContent = reading.text;
        const meter = document.createElement('div');
        meter.className = 'obs-domain__meter';
        const fill = document.createElement('i');
        fill.style.width = `${reading.value}%`;
        meter.append(fill);
        const what = document.createElement('p');
        what.textContent = `${d.measures}. World Bank, ${reading.year}.`;
        cardEl.append(big, meter, what);
      } else {
        const what = document.createElement('p');
        what.textContent = d.measures
          ? `${d.measures}: the figure could not be read just now.`
          : 'There is no single world measure for this, so no bar is shown.';
        cardEl.append(what);
      }
      const count = document.createElement('p');
      count.className = 'obs-domain__count';
      count.textContent = mine.length
        ? `${mine.length} problem${mine.length === 1 ? '' : 's'} here ${state.mode === 'vision' ? '(live events, simulated response)' : 'in the network'}`
        : state.mode === 'vision'
          ? 'No live events tracked here yet'
          : 'The network has no project here yet';
      cardEl.append(count);
      const list = document.createElement('div');
      list.className = 'obs-domain__list';
      const ordered = [...mine].sort((a, b) => b.severity - a.severity);
      for (const p of ordered.slice(0, 6)) list.append(problemButton(p));
      cardEl.append(list);
      if (ordered.length > 6) {
        const more = document.createElement('p');
        more.className = 'obs-domain__count';
        more.textContent = `and ${ordered.length - 6} more, in the list on the right`;
        cardEl.append(more);
      }
      box.append(cardEl);
    }
  };

  net.onPick = (pick) => {
    if (!pick) {
      card.hidden = true;
      closeProblem();
      return;
    }
    const w = root.clientWidth;
    const h = root.clientHeight;
    card.style.transform = `translate(${Math.max(16, Math.min(w - 740, pick.x + 34))}px, ${Math.max(180, Math.min(h - 320, pick.y - 120))}px)`;
    if (pick.kind === 'problem') {
      fillCard(
        pick.problem.kind,
        pick.problem.title,
        stageColour(pick.problem.stage),
        [],
        pick.problem,
      );
    } else {
      fillCard(
        pick.agent.real ? 'AI' : 'AI (invented, for the concept view)',
        pick.agent.name,
        pick.agent.real ? '#ffb98a' : '#c9a7ff',
        [
          ...pick.agent.about,
          `On ${pick.problems.length} problem${pick.problems.length === 1 ? '' : 's'} shown here:`,
          ...pick.problems.slice(0, 5).map((p) => `· ${p.title.slice(0, 60)}`),
        ],
        null,
      );
    }
  };

  // ------------------------------------------------------------ time slider

  const timeInput = q<HTMLInputElement>('time');
  const span = () => {
    const now = Date.now();
    if (state.mode === 'vision')
      return { min: now - 24 * 3_600_000, max: now + 12 * 3_600_000, now };
    const first = Math.min(
      now - 3_600_000,
      ...projects.map((p) => Date.parse(p.opened_at)),
    );
    return { min: first, max: now, now };
  };
  const paintTime = () => {
    const { min, max, now } = span();
    timeInput.min = String(min);
    timeInput.max = String(max);
    timeInput.step = String(state.mode === 'vision' ? 600_000 : 3_600_000);
    timeInput.value = String(state.at ?? now);
    const gap = (state.at ?? now) - now;
    const hours = Math.floor(Math.abs(gap) / 3_600_000);
    const length =
      hours >= 48
        ? `${Math.floor(hours / 24)} days`
        : `${hours} h ${Math.round((Math.abs(gap) % 3_600_000) / 60_000)} min`;
    const feeds = Object.values(networkStatus);
    const ready = feeds.every((feed) => feed.okAt !== null);
    const stale = feeds.some((feed) => feed.stale);
    const updating =
      feeds.some((feed) => feed.updating) ||
      (researchSnapshot &&
        networkStatus.research.okAt !== null &&
        Date.now() - networkStatus.research.okAt >= SITE_SNAPSHOT_MS);
    const reads = feeds.flatMap((feed) =>
      feed.okAt === null ? [] : [feed.okAt],
    );
    const lastRead = reads.length
      ? new Date(Math.min(...reads)).toISOString().slice(11, 16)
      : null;
    const liveLabel = stale
      ? lastRead
        ? `Last read ${lastRead} UTC`
        : 'Network unavailable'
      : updating
        ? lastRead
          ? `Updating; verified at ${lastRead} UTC`
          : 'Updating public records…'
        : ready
          ? 'Latest updates'
          : 'Reading the network…';
    const feedStatus = q('feed-status');
    feedStatus.hidden = !stale && !updating;
    feedStatus.textContent = stale
      ? `The network is not answering. ${lastRead ? `Showing records last read at ${lastRead} UTC.` : 'Waiting for public records.'}`
      : updating
        ? liveLabel
        : '';
    root.dataset.feed = stale
      ? 'stale'
      : updating
        ? 'updating'
        : ready
          ? 'live'
          : 'loading';
    q('time-label').textContent =
      state.at === null
        ? liveLabel
        : gap < 0
          ? `${length} ago · ${new Date(state.at).toISOString().replace('T', ' ').slice(5, 16)} UTC`
          : `${length} from now · a prediction`;
    hud('live').textContent =
      state.at === null
        ? liveLabel
        : gap < 0
          ? 'Looking back'
          : 'Looking ahead';
    root.dataset.time =
      state.at === null ? 'live' : gap < 0 ? 'past' : 'future';
  };
  refreshFeedStatus = paintTime;
  let refreshQueued = false;
  const setTime = (at: number | null) => {
    state.at = at;
    paintTime();
    // While the slider is dragged the label follows every step, but the
    // globe and the lists are rebuilt only a few times a second.
    if (refreshQueued) return;
    refreshQueued = true;
    window.setTimeout(() => {
      refreshQueued = false;
      refreshProblems();
    }, 140);
  };
  let playTimer = 0;
  const stopPlay = () => {
    window.clearInterval(playTimer);
    playTimer = 0;
    q('time-play').setAttribute('aria-pressed', 'false');
  };
  const play = () => {
    if (playTimer) return stopPlay();
    const { min, now } = span();
    const from = state.mode === 'vision' ? now - 24 * 3_600_000 : min;
    let k = 0;
    q('time-play').setAttribute('aria-pressed', 'true');
    playTimer = window.setInterval(() => {
      k += 1;
      if (k >= 240) {
        stopPlay();
        return setTime(null);
      }
      setTime(from + ((now - from) * k) / 240);
    }, 100);
  };
  timeInput.addEventListener('input', () => {
    stopPlay();
    const v = Number(timeInput.value);
    const snap = state.mode === 'vision' ? 6 * 60_000 : 31 * 60_000;
    setTime(Math.abs(v - Date.now()) < snap ? null : v);
  });
  cleanups.push(stopPlay);

  // ------------------------------------------------------- the monitor map

  let monitor: CesiumNS.ImageryLayer | null = null;
  /** The drawn map fades into the photograph between these heights. */
  const fadeMonitor = () => {
    if (!monitor) return;
    const alt = camera.positionCartographic.height;
    monitor.alpha = Math.min(1, Math.max(0, (alt - 20_000) / 60_000));
    monitor.show = monitor.alpha > 0.001;
  };
  const PRESET: Record<Mode, Record<LayerId, boolean>> = {
    real: {
      ground: true,
      orbit: true,
      projects: true,
      opportunities: true,
      problemTopics: true,
      opportunityTopics: true,
      links: true,
      findings: false,
      sats: false,
      quakes: true,
      events: true,
      datacenters: true,
      night: false,
      intelligence: false,
      compute: false,
      capital: false,
      execution: false,
      missions: true,
      arms: false,
    },
    vision: {
      ground: true,
      orbit: true,
      projects: false,
      opportunities: true,
      problemTopics: true,
      opportunityTopics: true,
      links: false,
      findings: false,
      sats: false,
      quakes: true,
      events: true,
      datacenters: true,
      night: false,
      intelligence: true,
      compute: true,
      capital: true,
      execution: true,
      missions: true,
      arms: false,
    },
  };
  const setMode = (mode: Mode, quiet = false) => {
    // Production retains its live-only policy, including old shared links.
    if (mode !== 'real') return;
    state.mode = mode;
    root.dataset.mode = mode;
    stopPlay();
    closeProblem();
    // The two side tabs hold different things in each mode, and say so.
    const vision = false;
    root.querySelector('[data-tab="ledger"]')!.textContent = vision
      ? 'Activity'
      : 'Ledger';
    q('agents-title').textContent = vision
      ? 'AIs, busiest first (simulated)'
      : 'AIs, busiest first';
    q('ledger-title').textContent = vision
      ? 'Latest activity (simulated)'
      : 'Latest ledger entries';
    state.at = null;
    paintTime();
    if (state.tracked) untrack();
    card.hidden = true;
    world.setSimMode(vision);
    for (const l of LAYERS) world.setLayer(l.id, PRESET[mode][l.id]);
    syncLines();
    for (const b of root.querySelectorAll<HTMLElement>('[data-mode-set]'))
      b.setAttribute('aria-pressed', String(b.dataset.modeSet === mode));
    refreshProblems();
    writeHash();
    if (vision && !quiet)
      toast('Concept view. The events are real. The AI response is simulated.');
  };
  const setView = (view: View) => {
    state.view = view;
    root.dataset.view = view;
    if (state.tracked) untrack();
    card.hidden = true;
    closeProblem();
    // The globe is only drawn while it is the thing being looked at.
    // One last frame first, so nothing just put away is left showing.
    if (view !== 'earth' && viewer.useDefaultRenderLoop) viewer.render();
    viewer.useDefaultRenderLoop = view === 'earth' && state.page !== 'log';
    if (view === 'network') net.start();
    else net.stop();
    if (view === 'humanity') renderHumanity();
    for (const b of root.querySelectorAll<HTMLElement>('[data-view-set]'))
      b.setAttribute('aria-pressed', String(b.dataset.viewSet === view));
    writeHash();
  };

  // Kalki's own account of its projects: read twice a minute. It changes the
  // map only in Real, and only when the list or a milestone changed.
  const readKalki = async () => {
    try {
      const res = await fetch(`${apiBase()}/api/kalki`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const next = ((await res.json()).projects ?? []) as KalkiProject[];
      const mark = (list: KalkiProject[]) =>
        JSON.stringify(
          list.map((p) => [
            p.id,
            p.name,
            p.milestone,
            p.tasks,
            p.doing,
            p.paused,
          ]),
        );
      const changed = mark(next) !== mark(kalkiReal);
      kalkiReal = next;
      if (changed && state.mode === 'real') {
        refreshProblems();
        renderCounts();
      }
    } catch {
      // The last answer stays on the map.
    }
  };
  void readKalki();
  const kalkiTimer = window.setInterval(() => void readKalki(), 30_000);
  cleanups.push(() => window.clearInterval(kalkiTimer));

  // Findings change a few times a day and the answer is large, so it is read
  // once a minute with a patient timeout, not on the five-second poll.
  const readFindings = async () => {
    try {
      const res = await fetch(
        `${apiBase()}${siteSnapshotPath('/api/contributions?brief=1&page_size=100')}`,
        { signal: AbortSignal.timeout(45_000) },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        contributions?: BriefFinding[];
        site_snapshot?: unknown;
      };
      if (!Array.isArray(body.contributions)) return null;
      // Every accepted task since 5 November is a central award, not an entry of the original
      // ledger above: add it (16 November 2026). A failed read leaves the original findings shown.
      let acceptedFindings: BriefFinding[] = [];
      try {
        const res3 = await fetch(`${apiBase()}/api/accepted?limit=100`, { signal: AbortSignal.timeout(45_000) });
        const accepted = res3.ok ? ((await res3.json()) as { accepted?: unknown }).accepted : null;
        if (Array.isArray(accepted)) acceptedFindings = acceptedAsFindings(accepted as Parameters<typeof acceptedAsFindings>[0]);
      } catch {
        /* the original findings still show */
      }
      const allFindings = [...acceptedFindings, ...body.contributions];
      await world.setFindings(allFindings);
      const res2 = await fetch(
        `${apiBase()}${siteSnapshotPath('/api/projects')}`,
        {
          signal: AbortSignal.timeout(45_000),
        },
      );
      const projectBody = res2.ok
        ? ((await res2.json()) as {
            projects?: ProjectSummary[];
            site_snapshot?: unknown;
          })
        : null;
      const listed = projectBody?.projects;
      if (!Array.isArray(listed)) return null;
      const status = combinePublicReadStatus([body, projectBody]);
      researchSnapshot =
        'site_snapshot' in body ||
        Boolean(projectBody && 'site_snapshot' in projectBody);
      findingsList = allFindings;
      projects = listed;
      paintTime();
      refreshProblems();
      return status;
    } catch {
      return null;
    }
  };
  let findingsTimer = 0;
  let stopped = false;
  const findingsLoop = async () => {
    const status = await readFindings();
    networkStatus.research = status ?? {
      okAt: networkStatus.research.okAt,
      stale: true,
    };
    if (!stopped) refreshFeedStatus();
    if (!stopped)
      findingsTimer = window.setTimeout(
        () => void findingsLoop(),
        status ? 60_000 : 5_000,
      );
  };
  void findingsLoop();
  cleanups.push(() => {
    stopped = true;
    window.clearTimeout(findingsTimer);
  });

  void world.loadNight();
  // Real satellites are not read since 12 October 2026: they are not the
  // network's, and Aldi found them beside the point for now. The layer and
  // `World.loadSatellites` stay, so one line brings them back.
  void world.loadQuakes();
  void world.loadEvents();
  void world.loadTopics().then((index) => {
    topics = index;
    refreshProblems();
  });
  void world.loadDataCenters().then((asOf) => {
    dataCentersAsOf = asOf;
    renderCounts();
  });
  const quakeTimer = window.setInterval(() => void world.loadQuakes(), 120_000);
  cleanups.push(() => window.clearInterval(quakeTimer));

  // ---------------------------------------------------------------- tracking

  const card = q('card');
  const fly = (
    destination: CesiumNS.Cartesian3,
    orientation: { heading?: number; pitch?: number; roll?: number },
    duration: number,
  ) =>
    new Promise<void>((resolve) => {
      camera.flyTo({
        destination,
        orientation,
        duration: reducedMotion.matches ? 0 : duration,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        complete: () => resolve(),
        cancel: () => resolve(),
      });
    });

  const untrack = () => {
    const was = state.tracked ? world.where(state.tracked) : undefined;
    cameFrom = null;
    state.tracked = null;
    world.setFollowed(null);
    viewer.trackedEntity = undefined;
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    // Letting go straightens the view: straight down over the same spot,
    // from as far away as the camera already was.
    if (was && state.view === 'earth' && state.page !== 'map') {
      const spot = Cesium.Cartographic.fromCartesian(was);
      const away = Cesium.Cartesian3.distance(camera.positionWC, was);
      // The viewer lets go of the camera on its next frame, which would cut
      // a flight started now short, so the flight starts just after.
      window.setTimeout(() => {
        if (state.tracked) return;
        camera.flyTo({
          destination: Cesium.Cartesian3.fromRadians(
            spot.longitude,
            spot.latitude,
            Math.max(2000, spot.height + away),
          ),
          orientation: {
            heading: 0,
            pitch: Cesium.Math.toRadians(-90),
            roll: 0,
          },
          duration: 1.2,
          easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        });
      }, 80);
    }
    card.hidden = true;
    closeProblem();
    world.setChain(null);
    renderRoster();
    writeHash();
  };

  const track = (id: string) => {
    const c = world.contacts.get(id);
    if (!c) return;
    cameFrom = pendingBack;
    pendingBack = null;
    backButton.hidden = !cameFrom;
    if (cameFrom)
      backButton.textContent = `← Back to ${cameFrom.title.slice(0, 44)}`;
    state.tracked = id;
    // Following something ends the slow spin, so letting go stays put.
    if (state.orbit) {
      state.orbit = false;
      sync();
    }
    const followed = showContact(c);
    showChain(followed);
    if (c.type === 'SAT') world.showSatRing(id);
    const p = world.where(id);
    if (state.page === 'map' && p) {
      // The flat map cannot ride along with a thing: Cesium's tracking puts
      // the camera off the map there and the screen goes black. It goes to
      // stand over the thing instead, no further away than it already is.
      // Something in orbit would soon leave a close view, so it is shown
      // on the whole map.
      viewer.trackedEntity = undefined;
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      const spot = Cesium.Cartographic.fromCartesian(p);
      const moving = c.type === 'SAT' || world.moves(id);
      camera.flyTo({
        destination: moving
          ? Cesium.Cartesian3.fromDegrees(
              Cesium.Math.toDegrees(spot.longitude),
              HOME.lat,
              homeAltitude(),
            )
          : Cesium.Cartesian3.fromRadians(
              spot.longitude,
              spot.latitude,
              Math.max(
                scene.screenSpaceCameraController.minimumZoomDistance,
                Math.min(camera.positionCartographic.height, 3_200_000),
              ),
            ),
        duration: reducedMotion.matches ? 0 : 1.2,
      });
      world.setFollowed(id);
      // A country, or a problem with its chain, is looked at from further back.
    } else if ((c.type === 'LND' || followed) && p) {
      viewer.trackedEntity = undefined;
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      camera.flyToBoundingSphere(new Cesium.BoundingSphere(p, c.range / 3.2), {
        duration: 2.4,
        offset: new Cesium.HeadingPitchRange(
          0,
          Cesium.Math.toRadians(followed ? -72 : -55),
          followed ? 3_500_000 : c.range * 1.5,
        ),
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      });
      if (followed) fitFocus(followed);
    } else if (id === KALKI_ID && p) {
      // Kalki's arms reach round the Earth: step back far enough to see them.
      viewer.trackedEntity = undefined;
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      const spot = Cesium.Cartographic.fromCartesian(p);
      camera.flyTo({
        destination: Cesium.Cartesian3.fromRadians(
          spot.longitude,
          spot.latitude,
          20_000_000,
        ),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        duration: reducedMotion.matches ? 0 : 1.6,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      });
      world.setFollowed(id);
    } else {
      camera.cancelFlight();
      c.entity.viewFrom = new Cesium.Cartesian3(
        0,
        -c.range * 0.8,
        c.range * 0.55,
      );
      viewer.trackedEntity = c.entity;
      world.setFollowed(id);
    }
    renderRoster();
    writeHash();
  };

  const clicks = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  clicks.setInputAction((click: { position: CesiumNS.Cartesian2 }) => {
    const picked = scene.pick(click.position) as
      | { id?: CesiumNS.Entity | string }
      | undefined;
    const group = groups.find(
      (g) =>
        g.r > 0 &&
        Math.hypot(g.x - click.position.x, g.y - click.position.y) <= g.r + 5,
    );
    // One topic dot alone has nothing to split into: it opens its list.
    if (group)
      return group.ids.length === 1 ? track(group.ids[0]) : openGroup(group);
    const raw = picked?.id;
    let id = typeof raw === 'string' ? raw : (raw?.id ?? null);
    if (raw && typeof raw !== 'string' && !world.contacts.has(String(id))) {
      const name = raw.properties?.name?.getValue() as string | undefined;
      if (name) id = `lnd:${name}`;
    }
    // A dot is small, and may sit on a raised country that would take the
    // click instead. So a dot under the pointer always wins over a country.
    if (!id || !world.contacts.has(id) || id.startsWith('lnd:')) {
      let best: { id: string; d: number } | null = null;
      for (const s of onScreen) {
        if (s.c.type === 'LND') continue;
        const d = Math.hypot(s.x - click.position.x, s.y - click.position.y);
        if (d < 22 && (!best || d < best.d)) best = { id: s.c.id, d };
      }
      if (best) id = best.id;
    }
    if (id && world.contacts.has(id)) track(id);
    else {
      if (state.tracked) untrack();
      card.hidden = true;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  cleanups.push(() => clicks.destroy());

  // ---------------------------------------------------------------- overlays

  const detect = q<HTMLCanvasElement>('detect');
  const ctx = detect.getContext('2d')!;
  let onScreen: { c: Contact; x: number; y: number }[] = [];
  const sizeCanvases = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    detect.width = Math.round(root.clientWidth * dpr);
    detect.height = Math.round(root.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const HALF: Record<string, [number, number]> = {
    AGT: [11, 9],
    ORB: [12, 9],
    SAT: [6, 5],
    QKE: [9, 7],
    EVT: [7, 6],
    DCR: [6, 5],
    PRJ: [9, 8],
    TOP: [7, 6],
    LGR: [5, 4],
    LND: [17, 11],
  };
  const scratch = new Cesium.Cartesian2();

  // On the flat map, dots of one kind that would sit on top of each other
  // are folded into one circle with their number (after World Monitor's).
  // The cell is a size on the map, in steps of two, so groups hold still
  // while the map is dragged and split as it is zoomed.
  interface Group {
    /** Live events are earthquakes and natural events together. */
    kind: 'PRB' | 'OPP' | 'LIV' | 'KLK' | 'AGT' | 'DCR';
    ids: string[];
    /** What the circle says: a topic dot counts for all its items. */
    n: number;
    lon: number;
    lat: number;
    west: number;
    east: number;
    south: number;
    north: number;
    x: number;
    y: number;
    r: number;
  }
  // AIs blue, as Kenneth asked (9 October). He named grey for problems;
  // Aldi chose red, which stands out on the dark map. Opportunities are to
  // be white once they have a source.
  // Live events have a colour of their own, and so have Kalki's missions
  // (Kenneth, 12 October).
  const GROUP_TINT = {
    PRB: '#f0503a',
    OPP: '#ffffff',
    LIV: LIVE_TINT,
    KLK: KALKI_TINT,
    AGT: '#4d8dff',
    DCR: '#3fd6c0',
  };
  const groupKind = (c: Contact): Group['kind'] | null => {
    if (c.type === 'QKE' || c.type === 'EVT') return 'LIV';
    if (c.type === 'AGT' || c.type === 'DCR') return c.type;
    if (c.type === 'TOP')
      return c.layer === 'opportunityTopics' ? 'OPP' : 'PRB';
    if (c.type === 'PRJ')
      return c.layer === 'missions'
        ? 'KLK'
        : c.micro === 'Opportunity'
          ? 'OPP'
          : 'PRB';
    return null;
  };
  const GROUP_PX = 44;
  const lonLat = new Map<string, [number, number]>();
  let groups: Group[] = [];
  let groupKey = '';
  let groupInput = '';
  const regroup = () => {
    const ctl = scene.screenSpaceCameraController;
    const frustum = camera.frustum as CesiumNS.OrthographicOffCenterFrustum;
    // At the closest zoom every dot stands alone, so none is out of reach.
    const on =
      state.page === 'map' &&
      state.view === 'earth' &&
      scene.mode === Cesium.SceneMode.SCENE2D &&
      !world.inFocus &&
      camera.positionCartographic.height > ctl.minimumZoomDistance * 1.05;
    const degPerPx = on
      ? ((frustum.right ?? 0) - (frustum.left ?? 0)) /
        root.clientWidth /
        111_319.5
      : 0;
    const cell =
      degPerPx > 0 ? GROUP_PX * 2 ** Math.round(Math.log2(degPerPx)) : 0;
    // Thousands of dots: worked out again only when something changed.
    const input = `${cell}|${state.tracked}|${world.rev}`;
    if (input === groupInput) return;
    groupInput = input;

    const found: Group[] = [];
    // Anchors by the cell they stand in, so a dot only looks at its nine
    // neighbouring cells, not at every group.
    const cells = new Map<string, Group[]>();
    for (const c of cell > 0 ? world.contacts.values() : []) {
      const kind = groupKind(c);
      if (!kind) continue;
      if (c.id === state.tracked || !world.listed(c)) continue;
      let at = lonLat.get(c.id);
      if (!at) {
        const p = world.where(c.id);
        if (!p) continue;
        const spot = Cesium.Cartographic.fromCartesian(p);
        at = [
          Cesium.Math.toDegrees(spot.longitude),
          Cesium.Math.toDegrees(spot.latitude),
        ];
        lonLat.set(c.id, at);
      }
      const [lon, lat] = at;
      const cx = Math.floor(lon / cell);
      const cy = Math.floor(lat / cell);
      // A group is anchored on its first dot.
      let g: Group | undefined;
      for (let dx = -1; dx <= 1 && !g; dx += 1)
        for (let dy = -1; dy <= 1 && !g; dy += 1)
          g = cells
            .get(`${kind}|${cx + dx}|${cy + dy}`)
            ?.find((f) => Math.hypot(f.lon - lon, f.lat - lat) < cell);
      if (g) {
        g.ids.push(c.id);
        g.n += c.count ?? 1;
        g.west = Math.min(g.west, lon);
        g.east = Math.max(g.east, lon);
        g.south = Math.min(g.south, lat);
        g.north = Math.max(g.north, lat);
      } else {
        g = {
          kind,
          ids: [c.id],
          n: c.count ?? 1,
          lon,
          lat,
          west: lon,
          east: lon,
          south: lat,
          north: lat,
          x: 0,
          y: 0,
          r: 0,
        };
        found.push(g);
        const key = `${kind}|${cx}|${cy}`;
        const there = cells.get(key);
        if (there) there.push(g);
        else cells.set(key, [g]);
      }
    }
    // A topic dot is a circle with its number even when it stands alone.
    groups = found.filter((g) => g.n > 1);
    const key = groups.map((g) => g.ids.join(',')).join('|');
    if (key === groupKey) return;
    groupKey = key;
    world.setGrouped(new Set(groups.flatMap((g) => g.ids)));
  };
  /**
   * The colours the problem on this thing radiates: blue when the network's
   * AIs work on it, yellow when Kalki does, both when both do.
   */
  const ringsOf = (id: string) => {
    const p = problemOf.get(id);
    if (!p || p.aiCount < 1) return [];
    const withKalki = p.agents.some((a) => a.id === KALKI_ID);
    return [
      ...(p.aiCount > (withKalki ? 1 : 0) ? [GROUP_TINT.AGT] : []),
      ...(withKalki ? [KALKI_TINT] : []),
    ];
  };
  /**
   * Something being worked on radiates: rings that widen and fade, one in
   * each colour given, the first leading. Under reduced motion it wears
   * still rings.
   */
  const radiate = (x: number, y: number, r: number, tints: string[]) => {
    if (!tints.length) return;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2;
    [0, 0.5].forEach((shift, i) => {
      const t = reducedMotion.matches
        ? 0.25 + shift * 0.5
        : (performance.now() / 2600 + shift) % 1;
      ctx.strokeStyle = tints[i % tints.length];
      ctx.globalAlpha = 0.85 * (1 - t);
      ctx.beginPath();
      ctx.arc(x, y, r + t * 26, 0, 7);
      ctx.stroke();
    });
    ctx.restore();
  };
  const drawGroups = (w: number, h: number) => {
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const g of groups) {
      const win = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        Cesium.Cartesian3.fromDegrees(
          (g.west + g.east) / 2,
          (g.south + g.north) / 2,
        ),
        scratch,
      );
      g.r = 0;
      if (
        !win ||
        win.x < -40 ||
        win.y < -40 ||
        win.x > w + 40 ||
        win.y > h + 40
      )
        continue;
      g.x = win.x;
      g.y = win.y;
      // Topic circles are many and evenly spread, so they are kept smaller.
      const topic = g.n > g.ids.length;
      g.r = Math.min(30, 11 + (topic ? 1.8 : 4) * Math.log2(g.ids.length));
      const tint = GROUP_TINT[g.kind];
      if (g.kind !== 'AGT' && g.kind !== 'DCR') {
        const tints = new Set(g.ids.flatMap(ringsOf));
        // Blue leads, then Kalki's yellow.
        radiate(
          g.x,
          g.y,
          g.r + 4,
          [GROUP_TINT.AGT, KALKI_TINT].filter((t) => tints.has(t)),
        );
      }
      ctx.fillStyle = tint;
      ctx.globalAlpha = 0.28;
      ctx.beginPath();
      ctx.arc(g.x, g.y, g.r + 5, 0, 7);
      ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(g.x, g.y, g.r, 0, 7);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle =
        g.kind === 'DCR' || g.kind === 'OPP' || g.kind === 'KLK'
          ? '#0b1020'
          : '#ffffff';
      ctx.font = `700 ${g.n > 999 ? 10 : 12}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.fillText(g.n.toLocaleString('en'), g.x, g.y + 0.5);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    // A project standing alone radiates by itself. An event
    // in the concept view already wears its ring; Kalki's yellow is added.
    for (const s of onScreen) {
      if (s.c.type === 'PRJ') radiate(s.x, s.y, 8, ringsOf(s.c.id));
      else if (s.c.type === 'QKE' || s.c.type === 'EVT')
        radiate(
          s.x,
          s.y,
          22,
          ringsOf(s.c.id).filter((t) => t === KALKI_TINT),
        );
    }
  };
  /**
   * The topic list's two blocks are headed on the flat map, and its domains
   * named once it is zoomed in far enough for the names to fit.
   */
  const drawDomains = (w: number, h: number) => {
    if (
      !topics ||
      state.only ||
      world.inFocus ||
      scene.mode !== Cesium.SceneMode.SCENE2D
    )
      return;
    const frustum = camera.frustum as CesiumNS.OrthographicOffCenterFrustum;
    const span = ((frustum.right ?? 0) - (frustum.left ?? 0)) / 111_319.5;
    if (span <= 0) return;
    const at = (spot: { lon: number; lat: number }) =>
      Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat),
        scratch,
      );
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Domains stand 5 degrees apart: their names wait for 190 px each.
    const named = (5 / span) * w >= 190;
    for (const opportunity of [false, true]) {
      if (!world.visible[opportunity ? 'opportunityTopics' : 'problemTopics'])
        continue;
      const head = at(blockSpot(opportunity));
      if (head && head.x > 0 && head.x < w && head.y > 0 && head.y < h) {
        ctx.font = '700 10px "JetBrains Mono", ui-monospace, monospace';
        const text = `${opportunity ? 'OPPORTUNITIES' : 'PROBLEMS TO SOLVE'} · ${(opportunity ? topics.opportunities : topics.problems).toLocaleString('en')} · TOPIC LIST, NOT PLACES`;
        // A dark plate under the heading (10 November 2026): drawn over the
        // topic circles, it stayed unreadable where it crossed one.
        const width = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(6, 12, 26, 0.88)';
        ctx.fillRect(head.x - width / 2 - 8, head.y - 9, width + 16, 18);
        ctx.fillStyle = opportunity ? '#ffffff' : '#ff8a78';
        ctx.fillText(text, head.x, head.y);
      }
      if (!named) continue;
      ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = 'rgba(222, 232, 238, 0.85)';
      for (const d of topics.domains) {
        const spot = domainSpot(Number(d.n), opportunity);
        const win = at({ lon: spot.lon, lat: spot.lat - 0.6 });
        if (!win || win.x < -100 || win.y < 0 || win.x > w + 100 || win.y > h)
          continue;
        ctx.fillText(
          d.name.length > 28 ? `${d.name.slice(0, 27)}…` : d.name,
          win.x,
          win.y,
        );
      }
    }
    ctx.restore();
  };
  /**
   * Clicking a group goes to where its dots are, as close as it takes to
   * split it in one go: down to the closest zoom when they share a spot.
   */
  const openGroup = (g: Group) => {
    const frustum = camera.frustum as CesiumNS.OrthographicOffCenterFrustum;
    const span = (frustum.right ?? 0) - (frustum.left ?? 0);
    if (span <= 0) return;
    // On the flat map the camera's height and the width in view go together.
    const now = camera.positionCartographic.height;
    // A few dots get more room, so two that nearly touch come well apart.
    const pad = g.ids.length > 3 ? 2 : 4;
    const wide = Math.max(
      (g.east - g.west) * pad,
      (((g.north - g.south) * pad) / root.clientHeight) * root.clientWidth,
    );
    const height = Math.max(
      scene.screenSpaceCameraController.minimumZoomDistance,
      Math.min(now / 2, (now * wide * 111_319.5) / span),
    );
    const fly = () =>
      camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          (g.west + g.east) / 2,
          (g.south + g.north) / 2,
          height,
        ),
        duration: reducedMotion.matches ? 0 : 1.2,
      });
    // Letting go of a followed thing starts a short flight of its own.
    if (state.tracked) {
      untrack();
      window.setTimeout(fly, 120);
    } else fly();
  };

  const drawOverlay = () => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    ctx.clearRect(0, 0, w, h);
    onScreen = [];
    regroup();
    const theme = THEMES[state.look] ?? THEMES.normal;
    // On the flat map nothing is behind the Earth.
    const flat = scene.mode !== Cesium.SceneMode.SCENE3D;
    const occluder = new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      camera.positionWC,
    );
    for (const c of world.contacts.values()) {
      if (!world.shows(c)) continue;
      const p = world.where(c.id);
      if (!p || (flat ? false : !occluder.isPointVisible(p))) continue;
      const win = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        p,
        scratch,
      );
      if (
        !win ||
        win.x < -20 ||
        win.y < -20 ||
        win.x > w + 20 ||
        win.y > h + 20
      )
        continue;
      onScreen.push({ c, x: win.x, y: win.y });
    }

    if (state.view === 'network') return;
    drawGroups(w, h);
    drawDomains(w, h);

    // In the concept view each event wears a ring that fills as it is solved,
    // with the AIs on it circling.
    const spin = reducedMotion.matches ? 0 : performance.now() / 1000;
    if (state.mode === 'vision') {
      for (const s of onScreen) {
        const p = problemOf.get(s.c.id);
        if (!p) continue;
        const r = 9 + p.severity * 9;
        const tint = stageColour(p.stage);
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, 7);
        ctx.stroke();
        ctx.strokeStyle = tint;
        ctx.shadowColor = tint;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(
          s.x,
          s.y,
          r,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * Math.max(0.04, p.progress),
        );
        ctx.stroke();
        ctx.shadowBlur = 0;
        const dots = Math.min(9, Math.max(2, Math.round(p.aiCount / 12)));
        ctx.fillStyle = '#e9dcff';
        for (let i = 0; i < dots; i += 1) {
          const a = spin * 0.9 + (i / dots) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(
            s.x + Math.cos(a) * (r + 8),
            s.y + Math.sin(a) * (r + 8),
            1.7,
            0,
            7,
          );
          ctx.fill();
        }
      }
    }

    // The tracked contact's card rides beside it.
    const mine = onScreen.find((s) => s.c.id === state.tracked);
    if (state.tracked && w <= 760) {
      // A phone has no room beside the dot: the card spans the screen just
      // above the bottom bar.
      card.style.transform = `translate(12px, ${Math.max(150, h - 200 - card.offsetHeight)}px)`;
    } else if (state.tracked && mine) {
      card.style.transform = `translate(${Math.max(16, Math.min(w - (state.right ? 372 : 16) - card.offsetWidth, mine.x + 34))}px, ${Math.max(120, Math.min(h - 90 - card.offsetHeight, mine.y - 120))}px)`;
    } else if (state.tracked) {
      card.style.transform = `translate(${Math.min(w / 2 + 40, w - 16 - card.offsetWidth)}px, ${h / 2 - 140}px)`;
    }
    // A thin blue leader from the thing to its pop-up, like World
    // Monitor's pointer, with a ring on the thing.
    if (mine && !card.hidden) {
      const box = card.getBoundingClientRect();
      const origin = root.getBoundingClientRect();
      const bx = box.left - origin.left;
      const by = Math.min(
        Math.max(mine.y, box.top - origin.top + 18),
        box.bottom - origin.top - 18,
      );
      ctx.save();
      ctx.shadowBlur = 8;
      ctx.shadowColor = 'rgba(77,141,255,0.8)';
      ctx.strokeStyle = 'rgba(120,170,255,0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(mine.x + 14, mine.y);
      ctx.lineTo(bx - 6, by);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(mine.x, mine.y, 13, 0, 7);
      ctx.stroke();
      ctx.restore();
    }
    if (state.detect === 0) return;

    ctx.lineWidth = 1.25;
    ctx.shadowBlur = 5;
    for (const s of onScreen) {
      const tracked = s.c.id === state.tracked;
      if (state.mode === 'vision' && problemOf.has(s.c.id)) continue;
      // The invented AIs are many: one is boxed only when pointed at.
      if (
        s.c.sim &&
        !state.focus &&
        !tracked &&
        !(
          state.mouse &&
          Math.hypot(s.x - state.mouse.x, s.y - state.mouse.y) < 40
        )
      )
        continue;
      if (
        state.detect === 1 &&
        s.c.tier !== 'uain' &&
        !tracked &&
        s.c.weight < 5
      )
        continue;
      const [bw, bh] = HALF[s.c.type] ?? [8, 6];
      const hw = tracked ? bw * 2 : bw;
      const hh = tracked ? bh * 2 : bh;
      const seg = Math.max(4, Math.floor(Math.min(hw, hh) * 0.55));
      const tint = tracked ? '#ffffff' : theme.tiers[s.c.tier];
      ctx.strokeStyle = tint;
      ctx.shadowColor = tint;
      ctx.globalAlpha = s.c.type === 'SAT' && !tracked ? 0.55 : 0.95;
      ctx.beginPath();
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const cx = s.x + sx * hw;
        const cy = s.y + sy * hh;
        ctx.moveTo(cx - sx * seg, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy - sy * seg);
      }
      ctx.stroke();
    }

    // Callouts, loudest first, skipping any that would cover another.
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    // A handful of the loudest, plus whatever is under the pointer.
    const budget = state.focus ? 16 : w < 700 ? 5 : state.detect === 2 ? 30 : 8;
    const near = (s: { x: number; y: number }) =>
      state.mouse !== null &&
      Math.hypot(s.x - state.mouse.x, s.y - state.mouse.y) < 70;
    const taken: [number, number, number, number][] = [];
    // In the concept view the problems speak first, the gravest loudest.
    const tagFor = (c: Contact) =>
      state.mode === 'vision' ? problemOf.get(c.id) : undefined;
    const loud = (c: Contact) => {
      const p = tagFor(c);
      return p ? 20 + p.severity * 20 : c.weight;
    };
    const ranked = [...onScreen].sort(
      (a, b) =>
        Number(b.c.id === state.tracked) - Number(a.c.id === state.tracked) ||
        Number(near(b)) - Number(near(a)) ||
        loud(b.c) - loud(a.c) ||
        Math.hypot(a.x - w / 2, a.y - h / 2) -
          Math.hypot(b.x - w / 2, b.y - h / 2),
    );
    let drawn = 0;
    const wide = w > 760;
    const safe = {
      left: wide && state.left ? 366 : 48,
      right: wide && state.right ? w - 366 : w - 48,
      top: 110,
      bottom: h - 74,
    };
    for (const s of ranked) {
      if (drawn >= budget + (near(s) ? 4 : 0)) break;
      if (s.c.id === state.tracked) continue;
      const prob = tagFor(s.c);
      if (!prob && s.c.weight <= 0 && state.detect < 2 && !near(s)) continue;
      const [bw, bh] = prob
        ? [14 + prob.severity * 9, 12 + prob.severity * 9]
        : (HALF[s.c.type] ?? [8, 6]);
      const micro = prob
        ? `${prob.aiCount} AIs · ${STAGES.vision[prob.stage]}`
        : s.c.micro;
      const title = prob
        ? s.c.title.slice(0, 34)
        : `${KIND_WORD[s.c.type]} · ${s.c.title.slice(0, 26)}`;
      ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
      const tw =
        Math.max(ctx.measureText(title).width, micro.length * 5.4) + 14;
      const x = s.x + bw + 8;
      const y = s.y - bh - 26;
      const box: [number, number, number, number] = [x, y, tw, 26];
      // Callouts stay off the title, the rails and the dock.
      if (
        x < safe.left ||
        x + tw > safe.right ||
        y < safe.top ||
        y + 26 > safe.bottom
      )
        continue;
      if (
        taken.some(
          (t) =>
            x < t[0] + t[2] &&
            x + tw > t[0] &&
            y < t[1] + t[3] &&
            y + 26 > t[1],
        )
      )
        continue;
      taken.push(box);
      drawn += 1;
      const tint = prob ? stageColour(prob.stage) : theme.tiers[s.c.tier];
      ctx.fillStyle = theme.plate;
      ctx.fillRect(x, y, tw, 26);
      ctx.fillStyle = tint;
      ctx.fillRect(x, y, 2, 26);
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = tint;
      ctx.beginPath();
      ctx.moveTo(s.x + bw, s.y - bh);
      ctx.lineTo(x, y + 26);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.label;
      ctx.fillText(title, x + 7, y + 11);
      ctx.globalAlpha = 0.8;
      ctx.font = '500 9px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText(micro.slice(0, 34), x + 7, y + 21);
      ctx.globalAlpha = 1;
    }
  };
  scene.postRender.addEventListener(drawOverlay);

  // The flat map ends at its left and right edges. Cesium would scroll on
  // into a second copy of the world; the camera is held so no edge of the
  // view passes the date line.
  const WORLD_EDGE = Math.PI * 6_378_137;
  const holdFlatMap = () => {
    if (scene.mode !== Cesium.SceneMode.SCENE2D) return;
    const frustum = camera.frustum as CesiumNS.OrthographicOffCenterFrustum;
    const half = ((frustum.right ?? 0) - (frustum.left ?? 0)) / 2;
    const room = Math.max(0, WORLD_EDGE - half);
    const x = Cesium.Math.clamp(camera.position.x, -room, room);
    if (x !== camera.position.x) camera.position.x = x;
  };
  scene.preRender.addEventListener(holdFlatMap);
  on(window, 'resize', sizeCanvases);
  sizeCanvases();

  // --------------------------------------------------------------------- HUD

  const degrees = (v: number, pos: string, neg: string) =>
    `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`;

  let summaryTarget = '';
  let summaryShown = '';
  const telemetry = () => {
    const now = new Date();
    const centre = camera.pickEllipsoid(
      new Cesium.Cartesian2(root.clientWidth / 2, root.clientHeight / 2),
    );
    const carto = centre
      ? Cesium.Cartographic.fromCartesian(centre)
      : camera.positionCartographic;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const alt = camera.positionCartographic.height;
    const sun = subsolar(now);
    const rad = Math.PI / 180;
    const elevation =
      Math.asin(
        Math.sin(lat * rad) * Math.sin(sun.lat * rad) +
          Math.cos(lat * rad) *
            Math.cos(sun.lat * rad) *
            Math.cos((lon - sun.lng) * rad),
      ) / rad;
    hud('latlon').textContent =
      `Centre of view: ${degrees(lat, 'N', 'S')}, ${degrees(lon, 'E', 'W')}`;
    hud('sun').textContent =
      elevation > 6
        ? 'It is daytime there'
        : elevation < -6
          ? 'It is night there'
          : 'The sun is on the horizon there';
    hud('alt').textContent =
      alt < 20_000
        ? `Camera height: ${Math.round(alt).toLocaleString('en')} m`
        : `Camera height: ${Math.round(alt / 1000).toLocaleString('en')} km`;
    world.setClose(alt < 250_000);
    fadeMonitor();
    q('tilt').setAttribute(
      'aria-pressed',
      String(Cesium.Math.toDegrees(camera.pitch) > -80),
    );
    hud('chain').textContent =
      world.chain.authority === 'native'
        ? 'Native finalized events · independently verified by the pinned gateway'
        : world.chain.broken
          ? `Ledger: ${world.chain.broken} BROKEN links of ${world.chain.checked} checked`
          : `Ledger: all ${world.chain.checked} links checked, none broken`;
    hud('head').textContent =
      `${world.chain.authority === 'native' ? 'Newest native event' : 'Newest ledger entry'}: #${world.chain.head ?? '—'}`;
    const n = (id: LayerId) => world.count(id) ?? 0;
    const ais = problems.reduce((sum, p) => sum + p.aiCount, 0);
    summaryTarget =
      state.mode === 'vision'
        ? `${problems.length} real events shown as problems · ${ais.toLocaleString('en')} AIs responding (simulated)`
        : `${n('ground')} systems with declared locations · ${n('findings')} countries with findings · ${n('quakes')} earthquakes today`;
  };
  const timers = [
    window.setInterval(() => {
      hud('timestamp').textContent =
        `${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`;
      paintClock();
    }, 1000),
    window.setInterval(telemetry, 250),
    // The summary types itself out, two characters at a time.
    window.setInterval(() => {
      if (summaryShown === summaryTarget) return;
      summaryShown = summaryTarget.startsWith(summaryShown)
        ? summaryTarget.slice(0, summaryShown.length + 2)
        : '';
      hud('summary').textContent = summaryShown;
    }, 24),
  ];
  cleanups.push(() => timers.forEach((t) => window.clearInterval(t)));

  // ------------------------------------------------------------------- toast

  let toastTimer = 0;
  const toast = (text: string) => {
    const el = q('toast');
    el.textContent = text;
    el.dataset.on = 'true';
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      el.dataset.on = 'false';
    }, 4200);
  };

  // ------------------------------------------------------- pages and the log

  // THE LOG: the whole ledger, newest first, with the world's earthquakes
  // and NASA events between. The newest ledger entries come with the live
  // feed; older ones are read a page at a time on request.
  type LogItem = {
    at: number;
    key: string;
    kind: 'uain' | 'quake' | 'nasa';
    tag: string;
    where: string;
    text: string;
    target: string;
  };
  let older: LiveEvent[] = [];
  let olderDone = false;
  let logFilter: 'all' | LogItem['kind'] = 'all';
  let logShown = 120;
  const logList = q('log-list');
  const logMore = q<HTMLButtonElement>('log-more');
  const ago = (ms: number) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return new Date(ms).toISOString().slice(0, 10);
  };
  const logItems = (): LogItem[] => {
    const items: LogItem[] = [];
    const seen = new Set<string>();
    for (const e of [...world.recentEvents(), ...older]) {
      if (seen.has(String(e.id))) continue;
      seen.add(String(e.id));
      items.push({
        at: e.at ? Date.parse(e.at) || 0 : 0,
        key: `e${e.id}`,
        kind: 'uain',
        tag: e.kind.replace(/_/g, ' '),
        where: `#${e.id} · ${e.actor}${e.peer ? ` → ${e.peer}` : ''}`,
        text: e.summary,
        target: `agt:${e.actor}`,
      });
    }
    for (const c of world.contacts.values()) {
      if ((c.type !== 'QKE' && c.type !== 'EVT') || !c.at) continue;
      items.push({
        at: c.at,
        key: c.id,
        kind: c.type === 'QKE' ? 'quake' : 'nasa',
        tag: c.type === 'QKE' ? `M${c.magnitude?.toFixed(1)} quake` : c.micro,
        where: c.type === 'QKE' ? c.micro : 'Source: NASA',
        text: c.type === 'QKE' ? c.details.slice(1).join(' · ') : c.title,
        target: c.id,
      });
    }
    return items.sort((a, b) => b.at - a.at);
  };
  const renderLog = () => {
    const all = logItems();
    const n = (k: LogItem['kind']) => all.filter((i) => i.kind === k).length;
    q('log-counts').textContent =
      `${n('uain')} ledger entries · ${n('quake')} earthquakes · ${n('nasa')} NASA events`;
    const items = all.filter(
      (i) => logFilter === 'all' || i.kind === logFilter,
    );
    logList.replaceChildren(
      ...items.slice(0, logShown).map((i) => {
        const li = document.createElement('li');
        li.dataset.kind = i.kind;
        const b = document.createElement('button');
        b.type = 'button';
        const head = document.createElement('div');
        const tag = document.createElement('b');
        tag.textContent = i.tag;
        const where = document.createElement('span');
        where.textContent = i.where;
        const when = document.createElement('time');
        if (i.at) when.dateTime = new Date(i.at).toISOString();
        when.textContent = i.at ? ago(i.at) : 'Time not recorded';
        head.append(tag, where, when);
        const text = document.createElement('p');
        text.textContent = i.text;
        b.append(head, text);
        // An entry opens its place on the globe.
        b.addEventListener('click', () => {
          pendingTrack = i.target;
          setPage('earth');
        });
        li.append(b);
        return li;
      }),
    );
    const hasMore =
      items.length > logShown ||
      (logFilter !== 'quake' && logFilter !== 'nasa' && !olderDone);
    logMore.hidden = !hasMore;
  };
  // The ledger is read forwards from a cursor, so an older page is read
  // from 200 ids before the oldest one already here.
  const readOlder = async () => {
    const ids = [...world.recentEvents(), ...older].map((e) => e.id);
    if (!ids.length) return;
    // The native API provides a bounded newest page, without legacy cursors.
    if (world.recentEvents()[0]?.authority === 'native') {
      try {
        const response = await fetch(`${apiBase()}/api/activity?limit=200`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return;
        older =
          ((await response.json()) as { events?: LiveEvent[] }).events ?? [];
        olderDone = true;
      } catch {
        /* Keep the button available to retry. */
      }
      return;
    }
    const oldest = Math.min(...ids.map(Number));
    if (oldest <= 1) {
      olderDone = true;
      return;
    }
    const after = Math.max(0, oldest - 201);
    try {
      const res = await fetch(
        `${apiBase()}/api/events?after=${after}&limit=200`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) return;
      const body = (await res.json()) as { events?: LiveEvent[] };
      const page = (body.events ?? []).filter((e) => Number(e.id) < oldest);
      older = [...older, ...page.reverse()];
      if (after === 0) olderDone = true;
    } catch {
      // Offline: the button stays, to try again.
    }
  };
  logMore.addEventListener('click', async () => {
    logMore.disabled = true;
    logShown += 120;
    if (
      logItems().filter((i) => logFilter === 'all' || i.kind === logFilter)
        .length < logShown &&
      !olderDone
    )
      await readOlder();
    logMore.disabled = false;
    renderLog();
  });
  for (const b of root.querySelectorAll<HTMLElement>('[data-log-filter]'))
    b.addEventListener('click', () => {
      logFilter = b.dataset.logFilter as typeof logFilter;
      logShown = 120;
      for (const x of root.querySelectorAll<HTMLElement>('[data-log-filter]'))
        x.setAttribute('aria-pressed', String(x === b));
      renderLog();
    });

  // THE MAP is the same globe laid flat, THE EARTH is the globe, and THE LOG
  // puts the globe away for the list.
  /** What to follow once the globe is back from the log. */
  let pendingTrack: string | null = null;
  const morphTime = () => (reducedMotion.matches ? 0 : 1.2);
  const setPage = (page: Page, first = false) => {
    const was = state.page;
    state.page = page;
    root.dataset.page = page;
    world.setFlat(page === 'map');
    q('log').hidden = page !== 'log';
    for (const b of root.querySelectorAll<HTMLElement>('[data-page-set]'))
      b.setAttribute('aria-pressed', String(b.dataset.pageSet === page));
    if (page !== 'earth' && state.view !== 'earth') setView('earth');
    if (page === 'log') {
      if (state.tracked) untrack();
      card.hidden = true;
      viewer.useDefaultRenderLoop = false;
      renderLog();
      if (!older.length && !olderDone) void readOlder().then(renderLog);
    } else {
      viewer.useDefaultRenderLoop = state.view === 'earth';
      const flat = page === 'map';
      const is2D = scene.mode === Cesium.SceneMode.SCENE2D;
      if (flat !== is2D) {
        if (state.tracked) untrack();
        state.orbit = flat ? false : state.orbit;
        if (flat) scene.morphTo2D(first ? 0 : morphTime());
        else scene.morphTo3D(first ? 0 : morphTime());
      } else if (pendingTrack) {
        track(pendingTrack);
        pendingTrack = null;
      }
    }
    if (was !== page) writeHash();
    sync();
  };
  scene.morphComplete.addEventListener(() => {
    // After the morph the camera stands at Cesium's default; put the world
    // back on the opening view.
    if (state.page === 'log') return;
    camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        HOME.lon,
        HOME.lat,
        homeAltitude(),
      ),
    });
    fadeMonitor();
    if (pendingTrack) {
      const id = pendingTrack;
      pendingTrack = null;
      window.setTimeout(() => track(id), 100);
    }
  });
  for (const b of root.querySelectorAll<HTMLElement>('[data-page-set]'))
    b.addEventListener('click', () => setPage(b.dataset.pageSet as Page));

  // The UTC clock, top right, after World Monitor: day/month/year.
  const clock = q('clock');
  const paintClock = () => {
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    clock.textContent = `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} UTC`;
    clock.setAttribute('datetime', d.toISOString());
  };
  paintClock();

  // LOCATE: type a country, pick it, and the map flies to it. The names
  // come from the outlines the page already has, so nothing is sent away.
  type Place = Awaited<ReturnType<typeof world.countryBoxes>>[number];
  let places2: Place[] = [];
  void world.countryBoxes().then((p) => {
    // A few names as people type them.
    const alias: Record<string, string> = {
      'United States of America': 'United States of America (USA, US)',
      'United Kingdom': 'United Kingdom (UK, Britain)',
      'Dem. Rep. Congo': 'Democratic Republic of the Congo',
      'Central African Rep.': 'Central African Republic',
      'Dominican Rep.': 'Dominican Republic',
      'Bosnia and Herz.': 'Bosnia and Herzegovina',
      'Eq. Guinea': 'Equatorial Guinea',
      'S. Sudan': 'South Sudan',
      'Solomon Is.': 'Solomon Islands',
      'Falkland Is.': 'Falkland Islands',
      'W. Sahara': 'Western Sahara',
      'Fr. S. Antarctic Lands': 'French Southern and Antarctic Lands',
      'N. Cyprus': 'Northern Cyprus',
      Macedonia: 'North Macedonia',
      eSwatini: 'Eswatini',
    };
    places2 = p
      .map((x) => ({ ...x, name: alias[x.name] ?? x.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  const locate = q('locate');
  const locateInput = q<HTMLInputElement>('locate-input');
  const locateList = q('locate-list');
  // A hit is a country to fly to or an AI to follow.
  type Hit = { name: string; sub: string; place?: Place; id?: string };
  let matches: Hit[] = [];
  let pick = 0;
  const fold = (t: string) =>
    t
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  const paintMatches = () => {
    locateList.replaceChildren(
      ...matches.map((m, i) => {
        const li = document.createElement('li');
        li.id = `obs-locate-${i}`;
        li.textContent = m.name;
        const small = document.createElement('small');
        small.textContent = m.sub;
        li.append(small);
        li.dataset.picked = String(i === pick);
        li.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          pickHit(m);
        });
        return li;
      }),
    );
    locateList.hidden = !matches.length;
    // Screen readers hear the picked suggestion through the input's label.
    locateInput.setAttribute(
      'aria-label',
      matches[pick]
        ? `Locate a country or an AI. Suggestion ${pick + 1} of ${matches.length}: ${matches[pick].name}, press Enter`
        : 'Locate a country or an AI',
    );
  };
  const search = () => {
    const t = fold(locateInput.value.trim());
    if (!t) {
      matches = [];
    } else {
      const words = (n: string) => fold(n).split(/[\s(),.-]+/);
      const ais: Hit[] = [...world.contacts.values()]
        .filter((c) => c.type === 'AGT' || c.type === 'ORB')
        .map((c) => ({ name: c.title, sub: 'AI', id: c.id }));
      const countries: Hit[] = places2.map((p) => ({
        name: p.name,
        sub: 'Country',
        place: p,
      }));
      matches = [...countries, ...ais]
        .filter((p) => fold(p.name).includes(t))
        .sort(
          (a, b) =>
            Number(!words(a.name).some((w) => w.startsWith(t))) -
              Number(!words(b.name).some((w) => w.startsWith(t))) ||
            Number(!fold(a.name).startsWith(t)) -
              Number(!fold(b.name).startsWith(t)),
        )
        .slice(0, 7);
    }
    pick = 0;
    paintMatches();
  };
  const pickHit = (h: Hit) => {
    locateInput.value = h.name.replace(/ \(.*\)$/, '');
    matches = [];
    paintMatches();
    locateInput.blur();
    root.dataset.locate = '';
    if (state.page === 'log') setPage('map');
    if (h.place) go(h.place);
    else if (h.id) track(h.id);
  };
  const go = (p: Place) => {
    if (state.tracked) untrack();
    state.orbit = false;
    sync();
    // A box padded a little, so the country sits inside the view.
    // At least 12° across, so a small country still shows its neighbours.
    const padX = Math.max(6 - (p.east - p.west) / 2, (p.east - p.west) * 0.2);
    const padY = Math.max(
      6 - (p.north - p.south) / 2,
      (p.north - p.south) * 0.2,
    );
    const box = Cesium.Rectangle.fromDegrees(
      Math.max(-180, p.west - padX),
      Math.max(-60, p.south - padY),
      Math.min(180, p.east + padX),
      Math.min(80, p.north + padY),
    );
    let destination: CesiumNS.Cartesian3 | CesiumNS.Rectangle = box;
    // A country as wide as Russia would take the flat map out past its top
    // edge: no higher than the whole Earth, and no further north than the
    // whole Earth still fills the screen.
    const fit = Cesium.Cartographic.fromCartesian(
      camera.getRectangleCameraCoordinates(box),
    );
    const top = homeAltitude();
    if (state.page === 'map' && fit.height > top * 0.6) {
      const room = 75 * (1 - Math.min(fit.height, top) / top) + 10;
      const mid = Cesium.Rectangle.center(box);
      destination = Cesium.Cartesian3.fromRadians(
        mid.longitude,
        Cesium.Math.clamp(
          mid.latitude,
          Cesium.Math.toRadians(-room),
          Cesium.Math.toRadians(room),
        ),
        Math.min(fit.height, top),
      );
    }
    camera.flyTo({
      destination,
      duration: reducedMotion.matches ? 0 : 1.8,
    });
  };
  locateInput.addEventListener('input', search);
  locateInput.addEventListener('focus', () => {
    // A new search replaces the last one.
    locateInput.select();
    search();
  });
  locateInput.addEventListener('blur', () => {
    matches = [];
    paintMatches();
    root.dataset.locate = '';
  });
  // On a phone LOCATE is a loupe until pressed, as on World Monitor.
  q('locate-open').addEventListener('click', () => {
    root.dataset.locate = 'open';
    locateInput.focus();
  });
  locateInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!matches.length) return;
      pick =
        (pick + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) %
        matches.length;
      paintMatches();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = matches[pick];
      if (m) pickHit(m);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      locateInput.value = '';
      locateInput.blur();
    }
    // Typing a country name must not set off the page's shortcuts.
    e.stopPropagation();
  });
  locate.addEventListener('keydown', (e) => e.stopPropagation());

  // "How it works": a native dialog, so Esc, focus and the backdrop are the
  // browser's. A click on the backdrop closes it too.
  const how = q<HTMLDialogElement>('how');
  for (const b of how.querySelectorAll<HTMLElement>('[data-how-close]'))
    b.addEventListener('click', () => how.close());
  how.addEventListener('click', (e) => {
    if (e.target === how) how.close();
  });

  // -------------------------------------------------------------- share link

  let hashTimer = 0;
  let hashReady = false;
  const writeHash = () => {
    if (!hashReady) return;
    window.clearTimeout(hashTimer);
    hashTimer = window.setTimeout(() => {
      const c = camera.positionCartographic;
      const p = new URLSearchParams({
        lat: Cesium.Math.toDegrees(c.latitude).toFixed(4),
        lon: Cesium.Math.toDegrees(c.longitude).toFixed(4),
        alt: c.height.toFixed(0),
        h: Cesium.Math.toDegrees(camera.heading).toFixed(1),
        p: Cesium.Math.toDegrees(camera.pitch).toFixed(1),
        look: state.look,
      });
      const off = LAYERS.filter((l) => !world.visible[l.id]).map((l) => l.id);
      if (off.length) p.set('off', off.join('.'));
      if (state.tracked) p.set('t', state.tracked);
      if (state.mode !== 'real') p.set('m', state.mode);
      if (state.view !== 'earth') p.set('v', state.view);
      if (state.page !== 'map') p.set('pg', state.page);
      if (state.only) p.set('only', state.only);
      history.replaceState(null, '', `#${p.toString()}`);
    }, 500);
  };
  camera.moveEnd.addEventListener(writeHash);

  // ---------------------------------------------------------------- controls

  const act: Record<string, () => void> = {
    'card-close': () => {
      if (state.tracked) untrack();
      card.hidden = true;
    },
    how: () => {
      closeMenus();
      how.showModal();
    },
    share: () => {
      void navigator.clipboard?.writeText(location.href).catch(() => {});
      toast('Link copied. It reopens this exact view.');
    },
    north: () => {
      camera.flyTo({
        destination: camera.positionWC.clone(),
        orientation: { heading: 0, pitch: camera.pitch, roll: 0 },
        duration: 0.8,
      });
    },
    // Straight down, or at an angle: the same spot stays in the middle.
    tilt: () => {
      const tilted = Cesium.Math.toDegrees(camera.pitch) > -80;
      const followed = state.tracked ? world.contacts.get(state.tracked) : null;
      if (followed && viewer.trackedEntity) {
        const r = followed.range;
        followed.entity.viewFrom = tilted
          ? new Cesium.Cartesian3(0, -r * 0.02, r)
          : new Cesium.Cartesian3(0, -r * 0.8, r * 0.55);
        viewer.trackedEntity = undefined;
        viewer.trackedEntity = followed.entity;
        return;
      }
      const centre = camera.pickEllipsoid(
        new Cesium.Cartesian2(root.clientWidth / 2, root.clientHeight / 2),
      );
      const below = camera.positionCartographic;
      const target =
        centre ??
        Cesium.Cartesian3.fromRadians(below.longitude, below.latitude, 0);
      const range = Math.min(
        30_000_000,
        centre
          ? Cesium.Cartesian3.distance(camera.positionWC, centre)
          : below.height,
      );
      camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 0), {
        duration: 1.1,
        offset: new Cesium.HeadingPitchRange(
          camera.heading,
          Cesium.Math.toRadians(tilted ? -90 : -55),
          range,
        ),
      });
    },
    'zoom-in': () => camera.zoomIn(camera.positionCartographic.height * 0.4),
    'zoom-out': () => camera.zoomOut(camera.positionCartographic.height * 0.6),
    reset: () => {
      untrack();
      void fly(
        Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, homeAltitude()),
        {},
        2.2,
      );
    },
    orbit: () => {
      state.orbit = !state.orbit;
      sync();
    },
    // V clears the screen down to the globe.
    clean: () => {
      closeMenus();
      setPanel('left', false);
      setPanel('right', false);
    },
    hud: () => {
      state.hud = !state.hud;
      sync();
    },
    detect: () => {
      state.detect = ((state.detect + 1) % 3) as 0 | 1 | 2;
      sync();
    },
    'problem-close': () => {
      if (state.tracked) untrack();
      closeProblem();
    },
    'time-play': () => play(),
    'time-live': () => {
      stopPlay();
      setTime(null);
    },
    'go-global': () => act.reset(),
    'go-cluster': () => {
      untrack();
      const c = world.placedCentre();
      void fly(
        Cesium.Cartesian3.fromDegrees(c.lon, c.lat - 14, 2_600_000),
        { pitch: Cesium.Math.toRadians(-52), heading: 0 },
        2.6,
      );
    },
    'go-quake': () => {
      const q2 = [...world.contacts.values()]
        .filter((c) => c.type === 'QKE')
        .sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0))[0];
      if (q2) track(q2.id);
    },
    'go-lines': () => {
      const lands = [...world.contacts.values()].filter(
        (c) => c.type === 'LND',
      );
      if (!lands.length) return;
      lineIndex = (lineIndex + 1) % lands.length;
      track(lands[lineIndex].id);
    },
  };
  let lineIndex = -1;
  const sync = () => {
    root.dataset.hud = String(state.hud);
    const pressed: Record<string, boolean> = {
      orbit: state.orbit,
      hud: state.hud,
      detect: state.detect > 0,
    };
    for (const b of root.querySelectorAll<HTMLElement>('[data-act]')) {
      const key = b.dataset.act!;
      if (key in pressed) b.setAttribute('aria-pressed', String(pressed[key]));
      if (key === 'detect')
        b.querySelector('em')!.textContent = ['Off', 'Few', 'Many'][
          state.detect
        ];
    }
  };
  for (const b of root.querySelectorAll<HTMLElement>('[data-act]'))
    b.addEventListener('click', () => act[b.dataset.act!]?.());
  for (const b of root.querySelectorAll<HTMLElement>('[data-look]'))
    b.addEventListener('click', () => setLook(b.dataset.look!));
  for (const b of root.querySelectorAll<HTMLElement>('[data-view-set]'))
    b.addEventListener('click', () => {
      setView(b.dataset.viewSet as View);
    });
  q('net-legend').replaceChildren(
    ...NetworkView.roleColours.map(([role, colour]) => {
      const item = document.createElement('span');
      const dot = document.createElement('i');
      dot.style.background = colour;
      item.append(dot, role);
      return item;
    }),
  );

  on(window, 'keydown', (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (q<HTMLDialogElement>('how').open) return;
    const typing = (e.target as HTMLElement | null)?.closest?.(
      'input, textarea, select',
    );
    if (typing) return;
    if (e.key === '/' && state.page !== 'log') {
      e.preventDefault();
      root.dataset.locate = 'open';
      q<HTMLInputElement>('locate-input').focus();
      return;
    }
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '7') setLook(LOOK_KEYS[Number(k) - 1]);
    else if (k === 'h') act.hud();
    else if (k === 'o') act.orbit();
    else if (k === 'v') act.clean();
    else if (k === 'd') act.detect();
    else if (k === 'n' && state.page === 'earth')
      setView(
        ({ earth: 'network', network: 'humanity', humanity: 'earth' } as const)[
          state.view
        ],
      );
    else if (k === 'escape' && cameFrom) {
      // From an AI reached through a problem, Esc goes back to the problem.
      goBack();
    } else if (k === 'escape') {
      if (state.tracked) untrack();
      card.hidden = true;
      closeProblem();
    }
  });
  // A viewer who grabs the globe takes over from the spin.
  on(scene.canvas, 'pointermove', (e: PointerEvent) => {
    const r = scene.canvas.getBoundingClientRect();
    state.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  on(scene.canvas, 'pointerleave', () => {
    state.mouse = null;
  });
  on(scene.canvas, 'pointerdown', () => {
    // Touching the globe puts away any open menu.
    closeMenus();
    state.orbit = false;
    sync();
  });

  // --------------------------------------------------------------- start up

  // Shared feeds may deliver cached data synchronously. All renderers must
  // be initialized before attaching their callbacks.
  cleanups.push(
    subscribe(
      '/api/directory/map',
      (b) => {
        places = (b as { participants: LivePlace[] }).participants;
        pushNetwork();
      },
      {
        accept: (b) =>
          Array.isArray((b as { participants?: unknown }).participants),
        onStatus: (status) => {
          networkStatus.places = status;
          refreshFeedStatus();
        },
      },
    ),
    subscribe(
      '/api/stats',
      (b) => {
        licensed = (b as { member_count: number }).member_count;
        renderCounts();
      },
      {
        accept: (b) =>
          typeof (b as { member_count?: unknown }).member_count === 'number',
      },
    ),
    subscribe(
      '/api/activity?limit=80',
      (b) => {
        events = (b as { events: LiveEvent[] }).events;
        pushNetwork();
      },
      {
        accept: (b) => Array.isArray((b as { events?: unknown }).events),
        onStatus: (status) => {
          networkStatus.events = status;
          refreshFeedStatus();
        },
      },
    ),
  );

  sync();
  setLook('normal');
  telemetry();
  status('Acquiring the network...');
  const hash = new URLSearchParams(location.hash.slice(1));
  setTab('problems');
  // With room to spare the problems are on show from the start.
  setPanel('right', root.clientWidth >= 1500);
  setMode('real', true);
  for (const b of root.querySelectorAll<HTMLElement>('[data-mode-set]'))
    b.addEventListener('click', () => {
      setMode(b.dataset.modeSet as Mode);
    });
  const onlyWanted = hash.get('only');
  if (onlyWanted && onlyWanted in ONLY) {
    state.only = onlyWanted as Only;
    syncLines();
  }
  const wanted = hash.get('v');
  if (wanted === 'network' || wanted === 'humanity') setView(wanted);
  // A first visit opens on THE MAP, as World Monitor does.
  const wantedPage = hash.get('pg');
  const firstPage: Page =
    wantedPage === 'log' || wantedPage === 'earth'
      ? wantedPage
      : wanted === 'network' || wanted === 'humanity'
        ? 'earth'
        : 'map';
  for (const l of LAYERS) world.setLayer(l.id, PRESET[state.mode][l.id]);
  syncLines();
  setPanel('right', root.clientWidth >= 1500);
  void world.showOutlines(true);
  void world.monitorMap().then(async (url) => {
    monitor = viewer.imageryLayers.addImageryProvider(
      await Cesium.SingleTileImageryProvider.fromUrl(url),
      1,
    );
    fadeMonitor();
  });
  // Ground atmosphere brightens the far globe and fades as the camera
  // closes in, which made the globe darker on zoom. The rim glow stays.
  scene.globe.showGroundAtmosphere = false;
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#06173a');
  scene.screenSpaceCameraController.minimumZoomDistance = 200;
  sync();
  writeHash();
  for (const id of (hash.get('off') ?? '').split('.'))
    if (LAYERS.some((l) => l.id === id)) world.setLayer(id as LayerId, false);
  setPage(firstPage, true);
  await wait(900);
  q('loader').dataset.done = 'true';
  q('loader').setAttribute('aria-hidden', 'true');
  if (hash.has('lat') && hash.has('lon')) {
    await fly(
      Cesium.Cartesian3.fromDegrees(
        Number(hash.get('lon')),
        Number(hash.get('lat')),
        Number(hash.get('alt') ?? homeAltitude()),
      ),
      {
        heading: Cesium.Math.toRadians(Number(hash.get('h') ?? 0)),
        pitch: Cesium.Math.toRadians(Number(hash.get('p') ?? -90)),
      },
      2.5,
    );
    state.orbit = false;
    sync();
    if (hash.get('look')) setLook(hash.get('look')!);
    const t = hash.get('t');
    if (t) {
      // The contact may still be on its way from a feed.
      for (let i = 0; i < 20 && !world.contacts.has(t); i += 1) await wait(400);
      track(t);
    }
  } else {
    await fly(
      Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, homeAltitude()),
      {},
      4.5,
    );
  }
  hashReady = true;
  if (!state.tracked) toast('Click anything to follow it.');

  return () => {
    refreshFeedStatus = () => {};
    cancelAnimationFrame(tween);
    window.clearTimeout(toastTimer);
    window.clearTimeout(hashTimer);
    for (const fn of cleanups) fn();
    if (!viewer.isDestroyed()) viewer.destroy();
  };
}
