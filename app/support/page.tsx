import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { SupportPage } from '@/components/donations/support-page';
export const metadata: Metadata = pageMetadata({
  title: 'Support research — UAIN',
  description:
    'Record your interest in supporting a UAIN research project. No payment is taken.',
  robots: { index: false, follow: true },
});
export default function Page() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        <SupportPage />
      </main>
      <SiteFooter />
    </>
  );
}
