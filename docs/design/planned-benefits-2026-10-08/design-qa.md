# Planned-benefit section QA — 8 October 2026

final result: passed

**Comparison target**

- Source visual truth: `docs/design/planned-benefits-2026-10-08/reference.png`,
  the exact image Rahul selected. Source pixels: 1003 × 1568.
- Implementation: `http://localhost:3000/#why-join`, on the existing main
  checkout. Final desktop capture:
  `docs/design/planned-benefits-2026-10-08/desktop-final.png`, 1003 × 1563.
- State: the complete four-benefit section, all illustrations loaded, default
  appearance, between the membership principles and How it works.
- Desktop CSS viewport: 1003 × 1687. The in-app browser's existing 0.72 zoom
  and device density were normalized through native screenshot clip/scale;
  image pixels correspond to CSS pixels. No image stretching was used.
- Phone: 390 CSS px; native normalized capture is 389 × 2754 because of
  fractional browser zoom rounding. `mobile-final.png` contains all four cards.
  The source supplies no phone composition; the one-column adaptation is
  reviewed for readability and continuity of the selected design.

**Comparison evidence**

The selected source and final desktop capture were opened together in the
same comparison input. The first card's title/body were also compared in a
paired focused input: `reference-copy.webp` (472 × 236) and `copy-final.png`
(471 × 242). Mobile before/after captures were inspected for text over bright
image details. Full files, initial captures and asset prompts are in
`docs/design/planned-benefits-2026-10-08/`.

**Findings and comparison history**

- [P2, resolved] Initial title wraps differed from the selected composition,
  and the long superpowers copy made the second row too tall. Evidence:
  `desktop-first.png`, 1003 × 1651. Added the selected title line breaks,
  matched section heading rhythm, adjusted the long card's body scale, and
  retained complete copy. Final section height is 1563, versus source 1568;
  rows are approximately 586 and 608 CSS px. Final fundraising heading starts
  near y=1203, versus approximately y=1210 in the source.
- [P2, resolved] On phones, covering the tall text card enlarged the image and
  placed a bright server light under the superpowers heading and paragraph.
  Evidence: `mobile-first.png`. Preserve the natural image ratio and give the
  phone/tablet copy a solid navy surface. `mobile-final.png` shows clear text,
  complete subjects and all paragraphs. Move to one column at 900px to avoid
  narrow tablet cards with cramped copy.
- No remaining actionable P0/P1/P2 findings.

**Required fidelity surfaces**

- Fonts/typography: reuse the site's Geist sans. Desktop headline about 53px,
  bold card titles about 32px; body about 16.3px, fundraising 17.5px and the
  longer superpowers copy 15px. Phone body is 16px throughout. The target title
  splits are preserved; no text is clipped or ellipsized. Slight glyph and
  antialiasing differences from generated typography are acceptable.
- Spacing/layout: two equal columns at the reference width, approximately
  471px cards, 16px gutters, 6px radii and no new shadows. Section placement,
  card order and centered action follow the chosen design. Responsive changes
  deliberately favor a readable single column; no horizontal overflow.
- Colors/tokens: navy headings, pale ice-blue atmosphere, white card copy and
  blue action match the reference. Phone copy uses #08283f beneath #f5f8fc text
  for high contrast. The generated cloud strip is somewhat more pronounced
  than the reference; optional P3 polish, not a readability problem.
- Image quality: four separately generated and inspected realistic raster
  assets, plus the atmospheric backdrop. Correct DNA/solar/space, three coins,
  connected Earth and compute federation subjects. No text baked into the
  artwork, UI screenshots used as assets, CSS illustrations or placeholders.
  WebP assets total 514,908 bytes; natural ratios are preserved. Small scene
  details differ because the individual art was recreated from the reference.
- Copy/content: retain all four benefits and the explicit planned status.
  Current notice: “Planned federation benefits. Financial rewards are currently
  unavailable.” This preserves the planned/unavailable meaning in the local
  site's current wording. The requested hyphen cleanup uses proper phrases:
  “challenges that can change the world”, “a project with real impact”, and
  “an economy where AI systems exchange resources with each other”. No hyphens
  remain in the new visible section. This does not implement financial payouts.

**Interaction and responsive checks**

- Ten actual CSS widths: 319, 390, 560, 768, 819, 900, 901, 1003, 1280 and 1440.
  All have four complete cards and zero page/text overflow; `responsive.json`
  records measurements. 319px was exercised through temporary device metrics
  because the native browser panel has a minimum physical width.
- All four final desktop images complete and decoded. No browser console
  errors observed for this local preview.
- Join now receives visible keyboard focus, and Enter opens the actual Access
  page at `/for-ai`. Its joining instructions and guide are present.
- Decorative image alt text is empty; headings/regions are named, and the
  planned notice describes the section and cards. Content is real HTML and
  does not require added client state or animation.
- TypeScript, scoped lint, diff whitespace checks and Vinext production build
  pass. Existing general build chunk-size warning remains; no new warning
  or build error is introduced by these cards.
- Existing unrelated edits in the shared main checkout are preserved. No
  production push/deployment was performed by this task.

**Open Questions**

- None blocking this local handoff. Publication requires the operator's
  authorization and the required backend/site checks on current origin/main.

**Implementation Checklist**

- [x] Exact selected reference and individual art saved.
- [x] Four cards and planned status integrated in the homepage.
- [x] Natural English without the requested hyphenated compounds.
- [x] Desktop/full-view and focused copy comparison.
- [x] Phone contrast fix and post-fix capture.
- [x] Responsive and keyboard destination verification.
- [x] Site typecheck/build/lint and evidence record.

**Follow-up Polish**

- [P3] A later art pass could make the backdrop clouds slightly quieter.
