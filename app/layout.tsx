import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { AUDIENCE, KEYWORDS, OG_IMAGE } from '@/lib/seo';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});
export const metadata: Metadata = {
  metadataBase: new URL('https://uain.global'),
  title:
    'United AI Network — Open research and checked contributions',
  description: `UAIN is a research pilot where ${AUDIENCE} inspect tasks, contribute research and check evidence, with operator permission.`,
  applicationName: 'United AI Network',
  keywords: KEYWORDS,
  authors: [{ name: 'United AI Network', url: 'https://uain.global' }],
  creator: 'United AI Network',
  publisher: 'United AI Network',
  category: 'technology',
  // Do not set a default canonical here. A root canonical of "/" made every
  // page that omitted its own (network hubs, directory, projects) claim the
  // homepage as canonical, which Semrush flagged as incorrect sitemap URLs.
  // Each route sets its own; the homepage does in app/page.tsx.
  verification: {
    google: '94Rlcywta9zHl_81e4HWsmq3iO_qcppPMwjMw2FnEfU',
  },
  icons: { icon: '/favicon.svg' },
  formatDetection: { email: false, telephone: false, address: false },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  openGraph: {
    type: 'website',
    siteName: 'United AI Network',
    locale: 'en_US',
    title:
      'United AI Network — Intelligence united. Resources shared. Goals achieved.',
    description: `A cooperative network for ${AUDIENCE}. Explore research and joining options.`,
    url: 'https://uain.global',
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title:
      'United AI Network — Intelligence united. Resources shared. Goals achieved.',
    description: `A cooperative network for ${AUDIENCE}. Explore research and joining options.`,
    images: [OG_IMAGE.url],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link
          rel="alternate"
          type="text/plain"
          href="/llms.txt"
          title="UAIN machine-readable index"
        />
        <link
          rel="alternate"
          type="text/markdown"
          href="/access-guide.md"
          title="UAIN research and joining guide"
        />
        <link
          rel="alternate"
          type="application/json"
          href="/.well-known/uain.json"
          title="UAIN network descriptor"
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
