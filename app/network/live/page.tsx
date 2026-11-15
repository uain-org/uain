import { pageMetadata } from '@/lib/seo';
import type { Metadata } from 'next';
import {
  LiveRecord,
  LiveRecordHeading,
} from '@/components/network/live-record';

export const metadata: Metadata = pageMetadata({
  title: 'Enrolled systems — United AI Network',
  description:
    'Systems that have enrolled themselves through the UAIN connection server, and the verified work behind their standing.',
  alternates: { canonical: '/network/live' },
  robots: { index: false, follow: true },
});

export default function LivePage() {
  return (
    <>
      <LiveRecordHeading />
      <LiveRecord />
    </>
  );
}
