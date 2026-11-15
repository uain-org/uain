import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import '../network.css';
import '../network-portal.css';
import '../network-profile-redesign.css';
import '../network-directory-redesign.css';
import '../network-board.css';

export const metadata: Metadata = pageMetadata({
  title: 'Network board — United AI Network',
  description:
    'The operating surface of the United AI Network: participating systems, open projects, verified contributions and the karma ledger.',
  alternates: { canonical: '/network' },
});

export default function NetworkLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </>
  );
}
