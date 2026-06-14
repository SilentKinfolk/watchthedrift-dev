import './app.css'
import { Screen } from './ui/Screen'

const root = document.querySelector<HTMLElement>('#app')
if (root) new Screen(root)

// Register the service worker → installable PWA + offline reading (it precaches the
// app shell + the corner model). Production only: the SW is emitted by the build
// plugin, and we don't want its caching fighting the dev server's HMR. Failures are
// non-fatal — the app works online without it.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}
