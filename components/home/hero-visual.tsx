'use client';

import { useEffect, useState } from 'react';

// All coordinates belong to the cleaned 1487 × 1058 background plate.
// The image, routes and points share one SVG coordinate system at every size.
const nodes = [
  { x: 1134, y: 402 },
  { x: 1080, y: 359 },
  { x: 1172, y: 319 },
  { x: 925, y: 429 },
  { x: 1340, y: 430 },
  { x: 1245, y: 527 },
  { x: 1090, y: 545 },
];
const routes = [
  'M 1134 402 Q 1098 370 1080 359',
  'M 1134 402 Q 1138 350 1172 319',
  'M 1134 402 Q 1025 357 925 429',
  'M 1134 402 Q 1242 345 1340 430',
  'M 1134 402 Q 1235 425 1245 527',
  'M 1134 402 Q 1074 458 1090 545',
];

function ConnectionNetwork() {
  return (
    <g className="home-hero-network">
      <g fill="none" strokeLinecap="round">
        {routes.map((d, index) => (
          <g
            className={`home-hero-route home-hero-route--${index + 1}`}
            key={d}
          >
            <path className="home-hero-route__track" d={d} />
            <path className="home-hero-route__glow" d={d} pathLength="100" />
            <path className="home-hero-route__trail" d={d} pathLength="100" />
            <path className="home-hero-route__head" d={d} pathLength="100" />
          </g>
        ))}
      </g>
      {nodes.map(({ x, y }, index) => (
        <g
          className={
            index === 0
              ? 'home-hero-node home-hero-node--hub'
              : 'home-hero-node'
          }
          key={`${x}-${y}`}
          transform={`translate(${x} ${y})`}
        >
          {index === 0 ? (
            <circle className="home-hero-node__ambience" r="22" />
          ) : null}
          <circle className="home-hero-node__halo" r={index === 0 ? 12 : 8} />
          <circle
            className="home-hero-node__core"
            r={index === 0 ? 3.8 : 2.5}
          />
          <circle
            className="home-hero-node__ring"
            r={index === 0 ? 7 : 5}
            style={{ animationDelay: `${index * -0.5}s` }}
          />
        </g>
      ))}
    </g>
  );
}

/** A line-free background plate with independently animated routes and points. */
function HeroBackground() {
  return (
    <>
      <image
        href="/images/landing/planet-dawn-clean.webp"
        width="1487"
        height="1058"
        preserveAspectRatio="none"
      />
      {/* Only this small source-image region changes; the Earth plate stays intact. */}
      <image
        href="/images/landing/planet-dawn-tagline.webp"
        x="1232.5"
        y="95.8"
        width="216.4"
        height="69.9"
        preserveAspectRatio="none"
      />
    </>
  );
}

export function HeroVisual() {
  const [allowMotion, setAllowMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (
      navigator as Navigator & {
        connection?: EventTarget & { saveData?: boolean };
      }
    ).connection;
    const update = () =>
      setAllowMotion(!query.matches && !connection?.saveData);
    update();
    query.addEventListener('change', update);
    connection?.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
      connection?.removeEventListener('change', update);
    };
  }, []);

  return (
    <>
      <link
        rel="preload"
        as="image"
        href="/images/landing/planet-dawn-clean.webp"
      />
      <div className="home-hero-copy-sky" aria-hidden="true">
        <svg viewBox="0 67 710 644" preserveAspectRatio="xMidYMid slice">
          <image
            href="/images/landing/planet-dawn-clean.webp"
            width="1487"
            height="1058"
            preserveAspectRatio="none"
          />
        </svg>
      </div>
      <div className="home-hero-visual" aria-hidden="true">
        <div
          className="home-hero-visual__frame"
          data-motion={allowMotion ? 'enabled' : 'disabled'}
        >
          <svg
            className="home-hero-visual__poster home-hero-visual__poster--desktop"
            viewBox="0 67 1487 644"
            preserveAspectRatio="xMaxYMid slice"
          >
            <HeroBackground />
            <ConnectionNetwork />
          </svg>
          <svg
            className="home-hero-visual__poster home-hero-visual__poster--mobile"
            viewBox="710 67 777 644"
            preserveAspectRatio="xMidYMid slice"
          >
            <HeroBackground />
            <ConnectionNetwork />
          </svg>
          <svg
            className="home-hero-visual__sky-tablet"
            viewBox="0 67 710 644"
            preserveAspectRatio="xMidYMid slice"
          >
            <image
              href="/images/landing/planet-dawn-clean.webp"
              width="1487"
              height="1058"
              preserveAspectRatio="none"
            />
          </svg>
        </div>
      </div>
    </>
  );
}
