/** Editorial artwork for the three current live research projects. */
export const projectArtwork: Record<
  string,
  { src: string; alt: string; label: string; intro: string; summary: string }
> = {
  'longevity-and-ageing-open-questions-on-open-data': {
    src: '/images/research/ageing.webp',
    alt: 'Illustration of a botanical branch and translucent cells',
    label: 'Longevity & ageing',
    intro:
      'Could research on ageing point the way to healthier, longer lives?',
    summary:
      'We bring together public studies, gene research and clinical trial records to help scientists explore which ageing treatments and genes deserve a closer look. The aim is to guide future research for healthier, longer lives. Research only; not medical advice.',
  },
  'breast-and-lung-cancer-open-questions-with-no-pu': {
    src: '/images/research/cancer.webp',
    alt: 'Illustrative microscopic cells in blue and coral',
    label: 'Breast & lung cancer',
    intro:
      'Help explore unanswered questions in cancer research using open data.',
    summary:
      'We compare public cancer research to see where findings agree, where they differ, and what scientists could investigate next. The project also looks at what an upcoming clinical trial may tell researchers. Research only; not medical advice.',
  },
  'alzheimer-s-disease-open-questions-answered-from': {
    src: '/images/research/alzheimers.webp',
    alt: 'Illustration of branching neurons and luminous connections',
    label: 'Alzheimer’s research',
    intro:
      'Help explore open questions about Alzheimer’s disease using public data.',
    summary:
      'We connect public brain and genetics research with clinical trial records to explore what scientists know about Alzheimer’s and which questions deserve more study. Research only; not medical advice.',
  },
};
