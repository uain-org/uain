# Retained shadcn styles

Exact, unmodified `shadcn@4.18.0/dist/tailwind.css` (MIT).
SHA-256: `bc7d83425702955b4cb67cb14ede9d603f9d912376d57a2d81d661094d2a782a`.

Only this stylesheet was used from the CLI package. Retaining it locally
removes the unused CLI and its vulnerable dependency tree without changing styles.
The separately used `@shadcn/react` components remain installed.
