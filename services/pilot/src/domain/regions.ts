/**
 * Coarse regions, not coordinates.
 *
 * The roadmap requires that the activity map "avoid exposing sensitive actor
 * identities, precise infrastructure locations, private capabilities, or
 * exploitable operational details". So an enrolling system declares a region,
 * never a point, and we place it at the region centroid with a few degrees of
 * jitter. Nothing in the store can be resolved back to a datacentre.
 */

export const REGIONS = {
  'af-north': { label: 'North Africa', lon: 10, lat: 28 },
  'af-west': { label: 'West Africa', lon: 0, lat: 12 },
  'af-east': { label: 'East Africa', lon: 38, lat: 2 },
  'af-south': { label: 'Southern Africa', lon: 25, lat: -25 },
  'eu-west': { label: 'Western Europe', lon: 4, lat: 50 },
  'eu-north': { label: 'Northern Europe', lon: 18, lat: 60 },
  'eu-south': { label: 'Southern Europe', lon: 14, lat: 42 },
  'eu-east': { label: 'Eastern Europe', lon: 30, lat: 50 },
  'me-west': { label: 'Middle East', lon: 45, lat: 28 },
  'as-south': { label: 'South Asia', lon: 78, lat: 22 },
  'as-east': { label: 'East Asia', lon: 114, lat: 34 },
  'as-southeast': { label: 'Mainland Southeast Asia', lon: 103, lat: 15 },
  'as-maritime': { label: 'Maritime Southeast Asia', lon: 112, lat: -3 },
  'as-central': { label: 'Central Asia', lon: 68, lat: 45 },
  oceania: { label: 'Oceania', lon: 145, lat: -30 },
  'na-east': { label: 'Eastern North America', lon: -77, lat: 40 },
  'na-west': { label: 'Western North America', lon: -120, lat: 40 },
  'na-central': { label: 'Central North America', lon: -98, lat: 42 },
  'sa-north': { label: 'Northern South America', lon: -60, lat: -5 },
  'sa-south': { label: 'Southern South America', lon: -62, lat: -33 },
  arctic: { label: 'Arctic', lon: -100, lat: 68 },
  unstated: { label: 'Unstated', lon: 0, lat: 0 },
};

export const REGION_IDS = Object.keys(REGIONS);
export type RegionId = keyof typeof REGIONS;
export interface RegionLocation { lon: number; lat: number; label: string }

/** Centroid plus deterministic jitter, so a system always lands in one place. */
export function placeInRegion(regionId: string, seed: string = ''): RegionLocation {
  const declared = REGIONS[regionId as RegionId];
  const region = declared ?? REGIONS.unstated;
  if (regionId === 'unstated' || !declared) {
    return { lon: region.lon, lat: region.lat, label: region.label };
  }
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 0) % 1000) / 1000 - 0.5;
  const b = ((h >>> 10) % 1000) / 1000 - 0.5;
  return {
    lon: Math.round((region.lon + a * 7) * 100) / 100,
    lat: Math.round((region.lat + b * 5) * 100) / 100,
    label: region.label,
  };
}
