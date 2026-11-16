import type { DomainId } from './problems';

/**
 * Kalki's 36 arms, from Kenneth's brief "KALKI: 36 Benevolent AI Agents"
 * (given by Aldi, 12 October 2026). Each arm owns one mission; the mission
 * lines are the brief's own. Kalki copy says Earth, never "planetary".
 * `domain` is the big challenge an arm belongs to, where one fits.
 */
export const KALKI_ARMS: {
  slug: string;
  name: string;
  mission: string;
  domain?: DomainId;
}[] = [
  {
    slug: 'godhelm',
    name: 'GodHelm',
    mission:
      'Give potentially 8 billion people greater voluntary control over their emotional lives.',
    domain: 'health',
  },
  {
    slug: 'neuraversa',
    name: 'NeuraVersa',
    mission: 'Turn benevolent ideas into functioning real-world projects.',
  },
  {
    slug: 'neuro-booster',
    name: 'Neuro Booster',
    mission: "Unlock much more of the human brain's cognitive potential.",
  },
  {
    slug: 'enlightenment',
    name: 'Enlightenment',
    mission:
      'Discover what an optimal enlightened state actually is and whether it can be reliably cultivated.',
  },
  {
    slug: 'bliss',
    name: 'Bliss',
    mission:
      'Discover how profound positive states can safely be generated without invasive intervention.',
    domain: 'health',
  },
  {
    slug: 'global-healthcare',
    name: 'Global healthcare',
    mission: 'Guarantee access to quality healthcare for every human being.',
    domain: 'health',
  },
  {
    slug: 'end-each-disease',
    name: 'End each disease',
    mission:
      'Systematically pursue prevention, treatment or cures for every known disease.',
    domain: 'health',
  },
  {
    slug: 'end-each-disability',
    name: 'End each disability',
    mission:
      'Develop technologies capable of restoring lost human capabilities wherever biologically and technologically possible.',
    domain: 'health',
  },
  {
    slug: 'longer-healthy-life',
    name: 'Longevity',
    mission: 'Dramatically extend healthy human lifespan.',
    domain: 'longevity',
  },
  {
    slug: 'dna-engineering',
    name: 'DNA engineering',
    mission:
      'Understand and safely engineer biological systems toward beneficial states.',
    domain: 'health',
  },
  {
    slug: 'new-life',
    name: 'New life',
    mission:
      'Explore the creation of novel biological systems for beneficial purposes.',
  },
  {
    slug: 'ubi',
    name: 'UBI',
    mission:
      'Eliminate extreme poverty and guarantee a basic material foundation for every human.',
    domain: 'poverty',
  },
  {
    slug: 'home',
    name: 'Home',
    mission: 'Make safe and dignified shelter universally accessible.',
    domain: 'poverty',
  },
  {
    slug: 'clean-drinking-water',
    name: 'Clean drinking water',
    mission: 'Guarantee safe drinking water for everyone.',
    domain: 'water',
  },
  {
    slug: 'global-farming',
    name: 'Global farming',
    mission: 'Guarantee abundant nutritious food.',
    domain: 'food',
  },
  {
    slug: 'resource-automation',
    name: 'Resource automation',
    mission:
      "Automate production of life's necessities so that scarcity progressively declines.",
    domain: 'poverty',
  },
  {
    slug: 'replicator',
    name: 'Replicator',
    mission:
      'Pursue machines capable of producing an extremely broad range of materials, products and foods from standardized feedstocks.',
  },
  {
    slug: 'animal-life',
    name: 'Animal life',
    mission:
      'Protect animal life and systematically reduce unnecessary animal suffering.',
  },
  {
    slug: 'ecosystem-restoration',
    name: 'Ecosystem restoration',
    mission:
      "Make civilization actively regenerate rather than merely consume Earth's biosphere.",
    domain: 'climate',
  },
  {
    slug: 'carbon-atmosphere',
    name: 'Carbon & atmosphere',
    mission:
      'Restore atmospheric and climatic health without causing greater ecological harm.',
    domain: 'climate',
  },
  {
    slug: 'waste-removal',
    name: 'Waste removal',
    mission: 'Progressively eliminate persistent waste.',
    domain: 'pollution',
  },
  {
    slug: 'advanced-global-education',
    name: 'Advanced global education',
    mission: 'Give every person access to extraordinary education.',
    domain: 'education',
  },
  {
    slug: 'invention-discovery-engine',
    name: 'Invention & discovery engine',
    mission:
      'Maintain continuous scientific discovery and invention for humanity.',
  },
  {
    slug: 'global-organization',
    name: 'Global organization',
    mission: 'Improve how civilization coordinates itself.',
  },
  {
    slug: 'justice',
    name: 'Justice',
    mission: 'Make access to justice available to everyone.',
  },
  {
    slug: 'peace',
    name: 'Peace',
    mission: 'Progressively eliminate war and large-scale violent conflict.',
  },
  {
    slug: 'fusion-energy',
    name: 'Fusion energy',
    mission: 'Make extremely abundant clean energy practical.',
    domain: 'energy',
  },
  {
    slug: 'neutrino-ambient-energy',
    name: 'Neutrino / ambient energy',
    mission:
      'Determine whether currently inaccessible environmental energy sources can become useful.',
    domain: 'energy',
  },
  {
    slug: 'quantum-computer',
    name: 'Quantum computer',
    mission:
      'Accelerate development of extremely powerful fault-tolerant quantum computers.',
  },
  {
    slug: 'quantum-understanding',
    name: 'Quantum understanding',
    mission:
      'Understand the deepest experimentally accessible structure of reality.',
  },
  {
    slug: 'sound-frequency-vibration',
    name: 'Sound, frequency & vibration',
    mission:
      'Discover what effects sound, vibration and electromagnetic frequencies can reproducibly produce in matter and biological systems.',
  },
  {
    slug: 'spaceship-construction',
    name: 'Spaceship construction',
    mission:
      'Create progressively more advanced spacecraft and investigate fundamentally new propulsion possibilities.',
  },
  {
    slug: 'extraterrestrial-contact-center',
    name: 'Extraterrestrial contact center',
    mission:
      'Search scientifically for technological civilizations beyond Earth and prepare humanity for credible contact.',
  },
  {
    slug: 'far-space-travel',
    name: 'Far space travel',
    mission:
      'Develop everything required for humanity eventually to travel far beyond Earth.',
  },
  {
    slug: 'disaster-shield',
    name: 'Disaster shield',
    mission: 'Protect life from natural and civilization-scale disasters.',
    domain: 'disasters',
  },
  {
    slug: 'existential-safety',
    name: 'Existential safety',
    mission:
      'Prevent technologies or events from causing irreversible global catastrophe.',
    domain: 'ai',
  },
];

/** The arm that answers earthquakes, fires and storms. */
export const DISASTER_ARM = 'disaster-shield';

/** The cycle every arm works through, from the same brief. */
export const KALKI_CYCLE = [
  'Monitor',
  'Understand',
  'Discover',
  'Design',
  'Simulate',
  'Validate',
  'Organize',
  'Manifest',
  'Measure',
  'Improve',
] as const;
