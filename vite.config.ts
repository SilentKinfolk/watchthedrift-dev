import { defineConfig } from 'vite'

// This is the v2 preview repo: its Project Pages live under
// https://silentkinfolk.github.io/watchthedrift-dev/ (production is the sibling
// /watchthedrift/), so every emitted asset URL must be prefixed with this repo name.
export default defineConfig({
  base: '/watchthedrift-dev/',
})
