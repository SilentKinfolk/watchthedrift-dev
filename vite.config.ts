import { defineConfig, type Plugin } from 'vite'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { renderServiceWorker, cacheName, uniqueUrls } from './scripts/service-worker.mjs'

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
  plugins: [serviceWorker()],
})

/**
 * Hand-rolled offline service worker (issue #13). No Workbox / vite-plugin-pwa: that
 * pulls a heavy dependency this minimal, hand-rolled-everything repo (we wrote our own
 * inference kernel rather than ship onnxruntime) doesn't want. Instead, at build we
 * already know every emitted filename, so we precache the exact set and ship a tiny SW.
 *
 * The precache list is the app shell + ALL hashed assets (JS, CSS, and the ?url corner
 * model) + the public PWA passthrough (manifest + icons). The SW source + cache-naming
 * live in scripts/service-worker.mjs (pure → unit-tested); this hook does the I/O:
 * collect the filenames and emit sw.js.
 */
function serviceWorker(): Plugin {
  let base = '/'
  let publicDir: string | false = false
  return {
    name: 'wtd-service-worker',
    apply: 'build',
    configResolved(cfg) {
      base = cfg.base
      publicDir = cfg.publicDir
    },
    generateBundle(_opts, bundle) {
      const emitted = Object.keys(bundle).filter((f) => !f.endsWith('.map')) // skip sourcemaps
      const publicFiles = publicDir ? listFiles(publicDir) : [] // manifest + icons
      const urls = uniqueUrls([
        base, // start_url (manifest start_url ".")
        `${base}index.html`,
        ...emitted.map((f) => base + f),
        ...publicFiles.map((f) => base + f),
      ])
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: renderServiceWorker(urls, cacheName(urls), base) })
    },
  }
}

/** Recursively list files under `dir` as forward-slash relative paths (URL-ready). */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}
