import { defineConfig } from 'vite'

// This is the v2 preview repo: its Project Pages live under
// https://silentkinfolk.github.io/watchthedrift-dev/ (production is the sibling
// /watchthedrift/), so every emitted asset URL must be prefixed with this repo name.
export default defineConfig({
  base: '/watchthedrift-dev/',
  build: {
    // Keep the corner model (`src/models/*`, imported `?url`) as real hashed files,
    // never inlined as data URIs. The manifest is only ~3 KB — under Vite's default
    // 4 KB inline limit — but inlining it would bury the model inside the JS bundle,
    // where the service worker can't precache it as its own asset and the clean
    // "model is a versioned same-origin file" story (issue #13) breaks. Everything
    // else keeps the default size-based inlining.
    assetsInlineLimit: (filePath) => (filePath.includes('/models/') ? false : undefined),
  },
})
