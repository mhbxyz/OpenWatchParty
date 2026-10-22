# OpenWatchParty project site

The site uses **Astro** for the product pages and **Starlight** for illustrated guides, installation documentation and developer references. It builds to static files for GitHub Pages.

## Run locally

Use Node.js 24 to match the site CI jobs (the package requires Node.js `>=22.23.4`):

```sh
cd docs
npm ci
npm run dev
```

Open the address printed by Astro with the `/OpenWatchParty/` base path, normally `http://127.0.0.1:4321/OpenWatchParty/`.

```sh
npm run check     # Astro and TypeScript diagnostics
npm run build     # Diagnostics, static build, search index and link verification
npm run preview   # Serve the production build locally
```

`SITE_BASE` selects the deployment path; its default is `/OpenWatchParty`. Set it to `/` for a root-domain deployment. `SITE_URL` controls the canonical site origin and defaults to `https://mhbxyz.github.io`. The deployment workflow passes GitHub Pages' configured base path.

## Source organization

| Location | Purpose |
| --- | --- |
| `src/pages/index.astro` | Compose the product home page |
| `src/layouts/LandingLayout.astro` | Product-page shell and metadata |
| `src/components/` | Shared branding, site navigation, paired video demo and interactive room previews |
| `src/scripts/` | Independent entrance animations, paired playback and preview interactions |
| `src/styles/` | Shared branding, product-page styles and Starlight theme |
| `src/config/navigation.mjs` | Documentation labels, grouping and ordering |
| `src/content/docs/product/` | Illustrated first watch party, room controls, features and FAQ |
| `src/content/docs/operations/` | Installation, deployment, configuration and maintenance |
| `src/content/docs/technical/` | Architecture, protocol, implementation and API references |
| `src/content/docs/development/` | Setup, contribution, tests, CI and releases |
| `src/content/docs/developers/` | Developer hub |
| `public/` | Images, real browser recordings, capacity data and Jellyfin plugin repository manifest |

Use ordinary Markdown and site-root links such as `/product/first-watch-party/`. The Markdown pipeline applies `SITE_BASE` to links and images at build time; code examples are preserved literally. Astro components use the shared `withBase()` helper. Starlight supplies search, heading navigation, code copying and mobile navigation.

The existing page URLs and heading anchors are retained. The build checks generated local links and assets and verifies the public routes recorded in `scripts/legacy-routes.json`. Keep these addresses stable when reorganizing navigation; navigation is independent of page titles.

## Record the product demo

The home page's two silent videos are real captures from separate Jellyfin browser sessions. See [recording provenance](public/assets/video/README.md). With the local demo stack and E2E dependencies ready, run from the repository root:

```sh
node e2e/capture-site-demo.js
```

This replaces the paired recordings under `public/assets/video/`. Screenshot provenance and film credits are documented in [the image directory](public/assets/images/README.md).

## Deployment

`.github/workflows/docs.yml` installs locked npm dependencies, runs the complete site build and uploads `docs/dist/` to GitHub Pages. The same build runs on pull requests in the main CI workflow. Site dependencies have their own npm audit and Dependabot updates.

The public plugin repository remains available at `/OpenWatchParty/jellyfin-plugin-repo/manifest.json`; the release workflow updates its source at `public/jellyfin-plugin-repo/manifest.json`.
