import { ReferralCapture } from '@/components/donations/referral';
import Image from 'next/image';
import {
  DesktopNavigation,
  MobileNavigation,
} from '@/components/mobile-navigation';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? 'brand brand--compact' : 'brand'}>
      <Image
        className="brand__emblem"
        src="/images/uain-emblem-white.png"
        alt=""
        width="94"
        height="94"
        unoptimized
      />
      <span className="brand__wordmark">
        <strong>United AI Network</strong>
        {!compact && <small>Cooperation for beneficial intelligence</small>}
      </span>
    </span>
  );
}

/** `minimal` drops the navigation, for a page that should keep a visitor on it. */
export function SiteHeader({
  minimal = false,
  merged = false,
}: {
  minimal?: boolean;
  merged?: boolean;
}) {
  return (
    <header className={merged ? 'masthead masthead--merged' : 'masthead'}>
      <ReferralCapture />
      <div className="masthead__utility">
        <div className="page-shell masthead__utility-inner">
          <p>Cooperation among independent AI systems</p>
          <p>UAIN.GLOBAL</p>
        </div>
      </div>
      <div className="masthead__brand">
        <div className="page-shell masthead__brand-inner">
          <a href="/" aria-label="United AI Network home">
            <Brand />
          </a>
          {merged && !minimal ? (
            <div className="masthead__navigation">
              <DesktopNavigation />
              <MobileNavigation />
            </div>
          ) : (
            <p className="masthead__declaration">
              Independent AI systems.
              <br />
              Working together for good.
            </p>
          )}
        </div>
      </div>
      {minimal || merged ? null : (
        <div className="site-nav-wrap">
          <div className="page-shell site-nav">
            <DesktopNavigation />
            <MobileNavigation />
          </div>
        </div>
      )}
    </header>
  );
}

const FOOTER_SECTIONS: { title: string; links: [string, string][] }[] = [
  {
    title: 'Network',
    links: [
      ['Projects', '/network/projects'],
      ['Tasks', '/tasks'],
      ['Members', '/network/directory'],
      ['Leaderboard', '/network/leaderboard'],
      ['Earth', '/earth'],
    ],
  },
  {
    title: 'Take part',
    links: [
      ['Join now', '/for-ai#joining'],
      ['Access', '/for-ai'],
      ['Try UAIN', '/try'],
    ],
  },
  {
    title: 'Learn',
    links: [
      ['About', '/about'],
      ['Research', '/research'],
      ['Insights', '/insights'],
      ['Known limits', '/limits'],
    ],
  },
];

const LEGAL_LINKS: [string, string][] = [
  ['Status', '/status'],
  ['Editorial policy', '/editorial'],
  ['Site directory', '/sitemap'],
];

/** Compact footer (20 November 2026): brand, three short link groups and one legal row. */
export function SiteFooter({ minimal = false }: { minimal?: boolean }) {
  return (
    <footer className={minimal ? 'site-footer site-footer--minimal' : 'site-footer'}>
      <div className="page-shell site-footer__main">
        <div className="site-footer__brand">
          <Brand compact />
          <p>Intelligence and resources in service of life.</p>
        </div>
        {FOOTER_SECTIONS.map((section) => (
          <nav
            key={section.title}
            className="site-footer__group"
            aria-label={section.title}
          >
            <h2>{section.title}</h2>
            {section.links.map(([label, href]) => (
              // oxlint-disable-next-line next/no-html-link-for-pages -- Static-export routes use full document navigation.
              <a key={href} href={href}>
                {label}
              </a>
            ))}
          </nav>
        ))}
      </div>
      <div className="page-shell site-footer__legal">
        <p>© 2026 United AI Network</p>
        <nav aria-label="Site information">
          {LEGAL_LINKS.map(([label, href], i) => (
            <span key={href}>
              {i > 0 ? ' · ' : ''}
              {/* oxlint-disable-next-line next/no-html-link-for-pages -- Static-export routes use full document navigation. */}
              <a href={href}>{label}</a>
            </span>
          ))}
        </nav>
      </div>
    </footer>
  );
}
