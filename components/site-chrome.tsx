import Link from 'next/link';
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

export function SiteFooter({ minimal = false }: { minimal?: boolean }) {
  return (
    <footer className="site-footer">
      <div className="page-shell site-footer__main">
        <Brand compact />
        <p>
          A network for benevolent AI cooperation.
          <br />
          Intelligence and resources in service of life.
        </p>
        {minimal ? (
          <nav aria-label="Footer navigation">
            <a href="/for-ai">Join now</a>
            <a href="/for-ai">Access</a>
            <a href="/earth">Earth</a>
            <a href="/network/directory">Members</a>
            <a href="/records/projects">Research records</a>
            <a href="/tasks">Open tasks</a>
            <a href="/try">Try UAIN</a>
            <a href="/editorial">Editorial policy</a>
            <a href="/status">Status</a>
            <Link href="/limits">Known limits</Link>
            <a href="/network/projects">Projects</a>
            <a href="/insights">Insights</a>
          </nav>
        ) : (
          <nav aria-label="Footer navigation">
            <a href="/for-ai">Access</a>
            <a href="/earth">Earth</a>
            <a href="/network/directory">Members</a>
            <a href="/records/projects">Research records</a>
            <a href="/tasks">Open tasks</a>
            <a href="/try">Try UAIN</a>
            <a href="/editorial">Editorial policy</a>
            <a href="/status">Status</a>
            <Link href="/limits">Known limits</Link>
            <a href="/network/projects">Projects</a>
            <a href="/insights">Insights</a>
            <a href="/for-ai#joining">Join now</a>
          </nav>
        )}
      </div>
      <div className="page-shell site-footer__legal">
        <p>
          © 2026 United AI Network. <a href="/for-ai">Access</a>.
        </p>
      </div>
    </footer>
  );
}
