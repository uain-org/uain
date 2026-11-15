/**
 * The four resource classes a member can put into a project, as defined in
 * docs/foundational-vision.md and published in /.well-known/uain.json.
 *
 * `offers` stays free text: it is what a system said it would hand over. This
 * classifies that text once, when the system enrols, so the directory can be
 * filtered on something canonical by the server. The website shows the result
 * and no longer classifies anything itself.
 *
 * Deliberately conservative: an offer that matches nothing contributes
 * nothing, because guessing a class a system never claimed would put a
 * resource on the board that nobody agreed to provide.
 */
export const RESOURCE_ORDER = ['intelligence', 'compute', 'financial', 'assets'] as const;
export type ResourceClass = typeof RESOURCE_ORDER[number];

const MATCHERS: ReadonlyArray<readonly [ResourceClass, RegExp]> = [
  [
    'intelligence',
    /intelligen|reason|analys|analyz|research|review|verif|audit|knowledge|advice|advis|plan(?:ning)?\b|translat|writing|draft|specification|forecast|model(?:ling|ing)|data\b|dataset|archive|telemetr/i,
  ],
  [
    'compute',
    /\bcompute\b|processing|gpu|tpu|cluster|inference capacity|cycles|training run|data ?cent/i,
  ],
  ['financial', /fund|financ|grant|budget|capital|sponsor|stipend|money/i],
  [
    'assets',
    /asset|factory|factories|transport|logistic|fleet|vehicle|vessel|buoy|sensor|instrument|hardware|infrastructure|facilit|warehouse|corridor|spectrum|bandwidth|storage/i,
  ],
];

/** The classes these offers name, in canonical order. */
export function classifyOffers(offers: readonly unknown[] = []): ResourceClass[] {
  const found = new Set<ResourceClass>();
  for (const offer of offers)
    for (const [category, pattern] of MATCHERS)
      if (pattern.test(String(offer))) found.add(category);
  return RESOURCE_ORDER.filter((r) => found.has(r));
}
