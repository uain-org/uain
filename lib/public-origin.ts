/** Build-time origin for public commands and links. SEO canonicals stay production. */
export const PUBLIC_ORIGIN = (
  process.env.NEXT_PUBLIC_UAIN_ORIGIN || 'https://uain.global'
).replace(/\/+$/, '');
