import type { Metadata } from 'next';
import '../../record-pages.css';

/*
 * The frame for the pages the connection server renders (10 November 2026):
 * the task list, each task, and the member and project records.
 *
 * Those pages are rendered on the server so crawlers and people without
 * scripts get the full text, and until now they had a plain template of their
 * own. This route is the network layout (skip link, site header, footer and
 * style sheets) with nothing in it. After the build, scripts/record-frame.mjs
 * cuts its header, footer and style links into /_record-frame/ fragments and
 * removes this page; the web nginx splices the fragments into the server's
 * pages (ssi, ops/nginx/docker.conf). Fragments and style sheets come from the
 * same build, so they always match, and the server fetches nothing.
 */
export const metadata: Metadata = {
  title: 'Record frame — United AI Network',
  robots: { index: false, follow: false },
};

export default function RecordFrame() {
  return <div className="record-frame-slot" />;
}
