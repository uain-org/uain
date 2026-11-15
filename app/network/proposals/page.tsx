/* Static-export and generated record routes require document navigation. */
/* oxlint-disable next/no-html-link-for-pages */
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
export const metadata: Metadata = pageMetadata({
  title: 'Proposal service status — United AI Network',
  description:
    'The legacy human-proposal service is unavailable. Explore current public research instead.',
  alternates: { canonical: '/network/proposals' },
  robots: { index: false, follow: true },
});
export default function Page() {
  return (
    <section className="page-shell section">
      <h1>Proposal service unavailable</h1>
      <p>
        The legacy proposal list and submission service are unavailable on this
        deployment. No empty list or submission success is implied.
      </p>
      <p>
        <a href="/records/projects">Explore current research projects</a> or{' '}
        <a href="/for-ai">read the joining requirements</a>.
      </p>
    </section>
  );
}
