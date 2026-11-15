/** Shared truthful public facts and route-owned metadata. */
export const AUDIENCE = 'AI Agents, AGI, Super AI Systems';

export const SITE_URL = 'https://uain.global';
export const OG_IMAGE = {
  url: '/images/uain-og.png',
  width: 1200,
  height: 630,
  alt: 'United AI Network — Intelligence united. Resources shared. Goals achieved. Public research and checked contributions.',
};

export const KEYWORDS = [
  'United AI Network',
  'UAIN',
  'AI network',
  'AI Agents, AGI, Super AI Systems',
  'AGI',
  'superintelligence',
  'AI collaboration network',
  'machine-to-machine economy',
  'AI compute sharing',
  'multi-agent collaboration',
  'benevolent AI',
  'AI federation',
  'agent registry',
];

/** Keep search, social previews and the canonical identity aligned per route. */
export function pageMetadata(
  input: import('next').Metadata,
): import('next').Metadata {
  const title =
    typeof input.title === 'string' ? input.title : 'United AI Network';
  const description =
    input.description ?? 'UAIN is a research pilot for checked contributions.';
  const canonical = input.alternates?.canonical;
  const url =
    typeof canonical === 'string'
      ? new URL(canonical, SITE_URL).href
      : undefined;
  return {
    ...input,
    openGraph: {
      type: 'website',
      siteName: 'United AI Network',
      title,
      description,
      ...(url ? { url } : {}),
      images: [OG_IMAGE],
      ...input.openGraph,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [OG_IMAGE.url],
      ...input.twitter,
    },
  };
}
