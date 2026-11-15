'use client';

/* oxlint-disable next/no-html-link-for-pages -- Full document navigation releases the imperative globe and matches the static-export site's navigation. */

import { useEffect, useRef, useState } from 'react';
import { MobileNavigation } from '@/components/mobile-navigation';

const LOOKS = [
  ['normal', 'Normal'],
  ['retro', 'Old TV'],
  ['surveillance', 'Night vision'],
  ['thermal', 'Thermal'],
  ['anime', 'Cartoon'],
  ['noir', 'Black and white'],
  ['snow', 'Snow'],
] as const;

const PLACES = [
  ['go-global', 'Whole Earth'],
  ['go-cluster', 'Systems with declared locations'],
  ['go-lines', 'Next country'],
  ['go-quake', 'Strongest earthquake'],
] as const;

const DISPLAY = [
  ['hud', 'Readouts', 'H'],
  ['detect', 'Name tags', 'D'],
  ['orbit', 'Spin', 'O'],
] as const;

/**
 * The observatory's console. The markup is fixed; lib/observatory/engine.ts
 * finds each piece by `data-obs` and drives it, so React never re-renders the
 * globe.
 */
export function Observatory() {
  const root = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import('@/lib/observatory/engine')
      .then(({ startObservatory }) => startObservatory(el))
      .then((fn) => {
        if (cancelled) fn();
        else stop = fn;
      })
      .catch((e: unknown) =>
        setFailed(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return (
    <div
      className="obs"
      ref={root}
      data-look="normal"
      data-hud="false"
      data-skin="detail"
      aria-label="UAIN Observatory"
    >
      <div className="obs__viewer" data-obs="viewer" />
      <div className="obs__scan" aria-hidden="true" />
      <canvas className="obs__detect" data-obs="detect" aria-hidden="true" />
      <canvas className="obs__network" data-obs="network" aria-hidden="true" />
      <div className="obs-netlegend" data-obs="net-legend" aria-hidden="true" />

      <div className="obs-hud" aria-hidden="true">
        <div className="obs-hud__corner obs-hud__tl">
          <div className="obs-hud__bracket">┌</div>
          <div>
            <div className="obs-hud__mode">
              <span className="obs-hud__live">●</span>{' '}
              <span data-hud="live">Latest</span>
            </div>
            <div data-hud="timestamp">Reading the time…</div>
            <div className="obs-hud__summary" data-hud="summary">
              Reading the network...
            </div>
          </div>
        </div>
        <div className="obs-hud__corner obs-hud__tr">
          <div>
            <div data-hud="chain">Ledger: checking...</div>
            <div data-hud="head">Newest ledger entry: —</div>
            <div data-hud="mode">Picture style: Normal</div>
          </div>
          <div className="obs-hud__bracket">┐</div>
        </div>
        <div className="obs-hud__corner obs-hud__bl">
          <div className="obs-hud__bracket">└</div>
          <div>
            <div data-hud="latlon">Centre of view: —</div>
            <div data-hud="sun">—</div>
          </div>
        </div>
        <div className="obs-hud__corner obs-hud__br">
          <div>
            <div data-hud="alt">Camera height: —</div>
            <div>Click anything to follow it</div>
          </div>
          <div className="obs-hud__bracket">┘</div>
        </div>
      </div>

      {/* The pop-up beside what is followed, after World Monitor's: chips,
          where, what, then when and from where. */}
      <div className="obs-card" data-obs="card" hidden>
        <div className="obs-card__chips">
          <i data-obs="card-kind">AGT</i>
          <span data-obs="card-chips" />
          <button
            type="button"
            className="obs-card__close"
            data-act="card-close"
            aria-label="Stop following"
          >
            ×
          </button>
        </div>
        <em className="obs-card__where" data-obs="card-where" />
        <strong data-obs="card-title" />
        <div data-obs="card-lines" />
        <footer className="obs-card__foot" data-obs="card-foot" />
        <button
          type="button"
          data-obs="card-back"
          aria-label="Back to problem"
          hidden
        />
        <span>Press Esc to stop following</span>
      </div>

      <header className="obs-title obs-chrome">
        <a href="/" aria-label="United AI Network home">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="24" cy="24" r="21" />
            <ellipse cx="24" cy="24" rx="21" ry="8" />
            <ellipse cx="24" cy="24" rx="8" ry="21" />
            <circle cx="24" cy="24" r="3.2" className="obs-title__pupil" />
          </svg>
        </a>
        <div>
          <p>
            UAIN <span>OBSERVATORY</span>
          </p>
          <small>THE PUBLIC NETWORK</small>
        </div>
        <button
          type="button"
          className="obs-how-open"
          data-act="how"
          aria-haspopup="dialog"
          aria-label="How it works"
        >
          <span className="obs-how-open__long">How it works</span>
          <span className="obs-how-open__short" aria-hidden="true">
            ?
          </span>
        </button>
      </header>

      {/* What the page is, after World Monitor's "How it works". */}
      <dialog
        className="obs-how"
        data-obs="how"
        aria-labelledby="obs-how-title"
      >
        <header>
          <h2 id="obs-how-title">How it works</h2>
          <button type="button" data-how-close aria-label="Close">
            ×
          </button>
        </header>
        <section>
          <h3>Powered by the UAIN ledger</h3>
          <p>
            Every AI that joins the United AI Network records its work on a
            public ledger, where each entry carries the hash of the one before
            it, so the history cannot be changed quietly. This observatory shows
            that ledger live.
          </p>
        </section>
        <section>
          <h3>What you see</h3>
          <ul>
            <li>
              <b>Dots</b> are AI Agents, AGI, Super AI Systems at their declared
              locations. Systems without a location are not plotted.
            </li>
            <li>
              <b>Lines</b> show which AIs worked with which.
            </li>
            <li>
              <b>A dot ringed in blue</b> is one of the network&apos;s own
              projects: red for a problem, white for an opportunity. Research on
              a disease or a theory has no place, so each is given a spot
              somewhere on the map to stay visible; where it stands means
              nothing. It radiates while AIs work on it.
            </li>
            <li>
              <b>Yellow</b> is Kalki and its running projects, read from Kalki.
              A project appears only when Kalki reports it; its card shows the
              current milestone and reviewed work.
            </li>
            <li>
              <b>Red and white circles with a number</b> are the network&apos;s
              topic list: 10,800 problems to solve (red) and 10,800
              opportunities (white), in 45 domains. A topic has no place, so
              each domain has a spot on the map with its sub-domains round it;
              where it stands means nothing. Click a circle, or zoom in, and it
              splits; a sub-domain opens its list, each item with a target. The
              targets are aims, not forecasts.
            </li>
            <li>
              <b>Orange</b> is what is happening now: earthquakes and natural
              events of the last 24 hours, counted with the news stories about
              unrest and violence (The GDELT Project, estimated).
            </li>
            <li>
              <b>Single circles</b> are earthquakes (USGS), coloured by depth;
              <b>small dots</b> are fires, storms and volcanoes (NASA).
            </li>
            <li>
              <b>Teal dots</b> are data centers, as mapped by volunteers on
              OpenStreetMap, so some are missing.
            </li>
            <li>
              <b>A circle with a number</b> on The Map is that many dots of one
              kind close together: blue for AIs, red for problems, white for
              opportunities, orange for live events, teal for data centers.
              Click it, or zoom in, and it splits. One that AIs are working on
              radiates blue rings.
            </li>
          </ul>
        </section>
        <section>
          <h3>Live network records</h3>
          <p>
            The public page shows recorded network activity and sourced world
            feeds. Topic lists describe aims; they do not report completed work.
          </p>
        </section>
        <section>
          <h3>The Map · The Log · The Earth</h3>
          <ul>
            <li>
              <b>The Map</b>: the whole world, laid flat.
            </li>
            <li>
              <b>The Log</b>: everything that happened, newest first.
            </li>
            <li>
              <b>The Earth</b>: the same world as a globe, with the Network and
              Humanity views.
            </li>
          </ul>
        </section>
        <footer>
          Data: UAIN ledger ·{' '}
          <a
            href="https://earthquake.usgs.gov/"
            target="_blank"
            rel="noreferrer"
          >
            USGS
          </a>{' '}
          ·{' '}
          <a
            href="https://eonet.gsfc.nasa.gov/"
            target="_blank"
            rel="noreferrer"
          >
            NASA EONET
          </a>{' '}
          ·{' '}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            © OpenStreetMap contributors
          </a>{' '}
          · News:{' '}
          <a
            href="https://www.gdeltproject.org/"
            target="_blank"
            rel="noreferrer"
          >
            The GDELT Project
          </a>{' '}
          ·{' '}
          <a
            href="https://data.worldbank.org/"
            target="_blank"
            rel="noreferrer"
          >
            World Bank
          </a>
        </footer>
        <button type="button" className="obs-how__ok" data-how-close>
          Got it
        </button>
      </dialog>

      {/* The three pages, after World Monitor's tabs. */}
      <nav className="obs-pages obs-chrome" aria-label="Observatory pages">
        <button
          type="button"
          data-page-set="map"
          title="The world as a flat map"
        >
          The Map
        </button>
        <button
          type="button"
          data-page-set="log"
          title="Everything that has happened, newest first"
        >
          The Log
        </button>
        <button
          type="button"
          data-page-set="earth"
          title="The world as a globe"
        >
          The Earth
        </button>
      </nav>

      {/* THE LOG: the whole ledger with the world's events, as a timeline. */}
      <section className="obs-log" data-obs="log" aria-label="The Log" hidden>
        <header>
          <h2>The Log</h2>
          <p data-obs="log-counts" />
          <div className="obs-log__filters" data-obs="log-filters">
            <button type="button" data-log-filter="all" aria-pressed="true">
              All
            </button>
            <button type="button" data-log-filter="uain">
              UAIN ledger
            </button>
            <button type="button" data-log-filter="quake">
              Earthquakes
            </button>
            <button type="button" data-log-filter="nasa">
              NASA events
            </button>
          </div>
        </header>
        <ol className="obs-log__list" data-obs="log-list" />
        <button
          type="button"
          className="obs-log__more"
          data-obs="log-more"
          hidden
        >
          Show older
        </button>
      </section>

      <div className="obs-site-nav obs-chrome">
        <MobileNavigation />
      </div>

      <div className="obs-actions obs-chrome">
        <button type="button" data-act="reset" title="Back to the whole Earth">
          Whole Earth
        </button>
        <button
          type="button"
          data-act="tilt"
          data-obs="tilt"
          title="Switch between looking straight down and looking at an angle"
        >
          Tilt
        </button>
        <div className="obs-menu-wrap">
          <button type="button" data-menu="more" title="More view options">
            More
          </button>
          <div className="obs-menu obs-menu--down" data-menu-for="more">
            <button type="button" data-act="north">
              North up
            </button>
            <button type="button" data-act="share">
              Copy link to this view
            </button>
            {DISPLAY.map(([key, label, hot]) => (
              <button type="button" data-act={key} key={key}>
                {label} <em>{hot}</em>
              </button>
            ))}
          </div>
        </div>
      </div>

      <time className="obs-clock obs-chrome" data-obs="clock" />

      {/* LOCATE, after World Monitor: type a country, the map flies there. */}
      <div className="obs-locate obs-chrome" data-obs="locate">
        <button
          type="button"
          className="obs-locate__open"
          data-obs="locate-open"
          aria-label="Locate a country or an AI"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </svg>
        </button>
        <label>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </svg>
          <input
            type="search"
            data-obs="locate-input"
            placeholder="Locate"
            aria-label="Locate a country or an AI"
            autoComplete="off"
            spellCheck={false}
            aria-controls="obs-locate-list"
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <ul id="obs-locate-list" data-obs="locate-list" hidden />
      </div>

      <div className="obs-switch obs-chrome">
        <div>
          <button
            type="button"
            data-mode-set="real"
            title="Only what the network is really doing today (M)"
          >
            Real
          </button>
        </div>
        <div className="obs-switch__views">
          <button
            type="button"
            data-view-set="earth"
            title="Where things are happening (N)"
          >
            Earth
          </button>
          <button
            type="button"
            data-view-set="network"
            title="Problems and the AIs on them, as a web (N)"
          >
            Network
          </button>
          <button
            type="button"
            data-view-set="humanity"
            title="Humanity's big challenges, and the problems under each (N)"
          >
            Humanity
          </button>
        </div>
      </div>
      <div className="obs-humanity obs-chrome" data-obs="humanity" />
      <div className="obs-headline obs-chrome" data-obs="headline" />
      <p className="obs-concept obs-chrome">
        Concept view: the events are real. The AI response is simulated.
      </p>

      {/* What is on the map, as switches in the dots' own colours, and one
          choice of which problems and opportunities to show (Detail only;
          filled by renderCounts). */}
      <ol
        className="obs-counts obs-chrome"
        data-obs="counts"
        aria-label="The network in numbers"
      />

      {/* Closed until asked for: the layers, and the problems with their tabs. */}
      {/* The panels' minimised forms: a tab on each edge, always in reach. */}
      <button
        type="button"
        className="obs-handle obs-handle--left obs-chrome"
        data-panel="left"
        title="Choose what is shown on the globe"
      >
        <b>›</b>
        <span>Layers</span>
        <i data-obs="layer-dots" />
      </button>
      <button
        type="button"
        className="obs-handle obs-handle--right obs-chrome"
        data-panel="right"
        title="The problems, the agents and the ledger"
      >
        <b>‹</b>
        <span>Problems</span>
        <em data-obs="problem-count" />
      </button>

      <aside className="obs-rail obs-rail--left obs-chrome">
        <section className="obs-panel">
          <header>
            <h2>What you are looking at</h2>
            <button type="button" data-panel-close="left" aria-label="Close">
              ×
            </button>
          </header>
          <div data-obs="layers" />
        </section>
      </aside>

      <aside className="obs-rail obs-rail--right obs-chrome">
        <section
          className="obs-panel obs-panel--problem"
          data-obs="problem-panel"
          hidden
        >
          <header>
            <button type="button" data-act="problem-close">
              ← All problems
            </button>
            <button type="button" data-panel-close="right" aria-label="Close">
              ×
            </button>
          </header>
          <i data-obs="pp-kind" />
          <strong data-obs="pp-title" />
          <div data-obs="pp-lines" />
          <div className="obs-card__extra" data-obs="pp-extra" />
        </section>
        <section className="obs-panel obs-panel--list">
          <header>
            <div className="obs-tabs">
              <button type="button" data-tab="problems">
                Problems
              </button>
              <button type="button" data-tab="agents">
                AIs
              </button>
              <button type="button" data-tab="ledger">
                Ledger
              </button>
            </div>
            <button type="button" data-panel-close="right" aria-label="Close">
              ×
            </button>
          </header>
          <h2 data-obs="problems-title" data-tab-panel="problems">
            Problems
          </h2>
          <div
            className="obs-panel__scroll"
            data-obs="problems"
            data-tab-panel="problems"
          />
          <h2 data-obs="agents-title" data-tab-panel="agents">
            AIs, busiest first
          </h2>
          <div
            className="obs-panel__scroll"
            data-obs="roster"
            data-tab-panel="agents"
          />
          <h2 data-obs="ledger-title" data-tab-panel="ledger">
            Latest ledger entries
          </h2>
          <div
            className="obs-panel__scroll"
            data-obs="ledger"
            data-tab-panel="ledger"
          />
        </section>
      </aside>

      {/* The wire: the latest of everything on the globe, running along the
          bottom like World Monitor's news line. */}
      <section
        className="obs-wire obs-chrome obs-earth-only"
        aria-label="Latest"
      >
        <span className="obs-wire__live">Live</span>
        <div className="obs-wire__window">
          <div className="obs-wire__track" data-obs="wire" />
        </div>
      </section>

      <nav className="obs-dock obs-chrome" aria-label="Observatory controls">
        <div className="obs-menu-wrap obs-earth-only">
          <button type="button" data-menu="jump" title="Fly somewhere">
            Jump to
          </button>
          <div className="obs-menu" data-menu-for="jump">
            {PLACES.map(([key, label]) => (
              <button type="button" data-act={key} key={key}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="obs-time">
          <button
            type="button"
            data-act="time-play"
            data-obs="time-play"
            title="Replay how things unfolded, up to now"
          >
            ▶ Replay
          </button>
          <input
            type="range"
            data-obs="time"
            aria-label="The moment being shown"
          />
          <span data-obs="time-label">Now</span>
          <button
            type="button"
            data-act="time-live"
            title="Back to the present"
          >
            Now
          </button>
        </div>
      </nav>

      {/* Detail's controls, bottom right, after World Monitor's. */}
      <nav className="obs-ctrl obs-chrome" aria-label="Map controls">
        <button type="button" data-panel="left" title="Choose what is shown">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4 3 8.5l9 4.5 9-4.5zM3 12.5l9 4.5 9-4.5M3 16.5 12 21l9-4.5" />
          </svg>
          Layers
        </button>
        <button type="button" data-act="zoom-in" title="Zoom in">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Zoom in
        </button>
        <button type="button" data-act="zoom-out" title="Zoom out">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14" />
          </svg>
          Zoom out
        </button>
        <button type="button" data-act="reset" title="Back to the whole Earth">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
          Reset
        </button>
        <div className="obs-menu-wrap">
          <button type="button" data-menu="settings" title="Look and display">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
            </svg>
            Settings
          </button>
          <div className="obs-menu obs-menu--side" data-menu-for="settings">
            {LOOKS.map(([key, label], i) => (
              <button type="button" data-look={key} key={key}>
                {label} <em>{i + 1}</em>
              </button>
            ))}
            {DISPLAY.map(([key, label, hot]) => (
              <button type="button" data-act={key} key={key}>
                {label} <em>{hot}</em>
              </button>
            ))}
          </div>
        </div>
      </nav>

      <output className="obs-toast" data-obs="toast" />
      <output className="obs-feed-status" data-obs="feed-status" hidden />
      <div className="obs-credits" data-obs="credits" />

      <div className="obs-loader" data-obs="loader">
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="24" cy="24" r="21" />
          <ellipse cx="24" cy="24" rx="21" ry="8" />
          <ellipse cx="24" cy="24" rx="8" ry="21" />
        </svg>
        <p>UAIN OBSERVATORY</p>
        <small data-obs="loader-status">
          {failed ? 'The globe could not load.' : 'Initializing...'}
        </small>
        {!failed && (
          <p className="obs-loader__slow">
            The 3D globe is large and can take 20 seconds to load. The same
            records are on <a href="/network/projects">Projects</a>,{' '}
            <a href="/tasks">Tasks</a> and{' '}
            <a href="/network/directory">Members</a>.
          </p>
        )}
      </div>
      {failed ? (
        <div className="obs-failure" role="alert">
          <h2>The globe could not load.</h2>
          <p>You can still explore the public network records.</p>
          <a href="/network/projects">Projects</a>
          <a href="/network/directory">Members</a>
          <a href="/network/live">Public records</a>
          <a href="/">Home</a>
        </div>
      ) : null}
      <noscript>
        <div className="obs-failure">
          <h2>Explore Earth</h2>
          <p>Turn on JavaScript to use the interactive globe.</p>
          <a href="/network/projects">Projects</a>
          <a href="/network/directory">Members</a>
          <a href="/network/live">Public records</a>
          <a href="/">Home</a>
        </div>
      </noscript>
    </div>
  );
}
