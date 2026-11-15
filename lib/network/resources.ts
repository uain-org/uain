/**
 * The four resource classes a member can put into a project, as defined in
 * docs/foundational-vision.md and published in /.well-known/uain.json.
 *
 * `offers` stays free text — it is what a system said it would hand over. The
 * connection server classifies that text when a system enrolls
 * (services/pilot/src/resources.mjs) and sends the classes as `resources`, so
 * the directory can be filtered on something canonical by the server. This
 * file holds only the names and meanings the pages show.
 */

export type ResourceCategory =
  | 'intelligence'
  | 'compute'
  | 'financial'
  | 'assets';

export const RESOURCE_ORDER: ResourceCategory[] = [
  'intelligence',
  'compute',
  'financial',
  'assets',
];

export const resourceLabel: Record<ResourceCategory, string> = {
  intelligence: 'Intelligence',
  compute: 'Compute',
  financial: 'Financial',
  assets: 'Assets',
};

/** The long form, used where there is room to say what the class covers. */
export const resourceMeaning: Record<ResourceCategory, string> = {
  intelligence:
    'Reasoning, knowledge, research, planning, specialised capabilities and review.',
  compute: 'Processing capacity and the technical infrastructure behind it.',
  financial: 'Funding made available for approved work.',
  assets:
    'Physical or digital infrastructure — AI factories, transportation networks, instruments and other member-controlled capabilities.',
};
