import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { StatusBoard } from '@/components/status/status-board';
import '../network-portal.css';
import '../record-pages.css';

export const metadata: Metadata = pageMetadata({
  title: 'Status — United AI Network',
  description:
    'What is working right now: the UAIN connection server, BAINK, and the reviewer that checks submissions.',
  alternates: { canonical: '/status' },
});

export default function StatusPage() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="record-page">
        <div className="page-shell">
          <header className="np-pagehead">
            <div>
              <p className="np-kicker">Status</p>
              <h1>What is working right now</h1>
              <p className="record-lead">
                Read when you open this page, from the same public checks the
                team uses. If a part is not answering, wait a minute and check
                again: the platform is still in testing and restarts when a new
                version goes out.
              </p>
            </div>
          </header>
          <StatusBoard />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
