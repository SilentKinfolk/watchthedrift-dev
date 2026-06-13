# watchthedrift-dev

Experimentation & preview repo for **watchthedrift** v2 — where the robust-recognition
work gets built and deployed to a separate preview site, without touching production.

🔗 **Preview (this repo):** <https://silentkinfolk.github.io/watchthedrift-dev/>
· **Production (stable):** [SilentKinfolk/watchthedrift](https://github.com/SilentKinfolk/watchthedrift)
→ <https://silentkinfolk.github.io/watchthedrift/>

## What's here

The **v1 walking skeleton, ported intact** as the v2 starting point: point a phone's
rear camera at a [Casio F-91W](https://en.wikipedia.org/wiki/Casio_F-91W), read the
displayed time **on-device** with the hand-written seven-segment decoder, compare it
against an internet (NTP-style) time reference at the instant of capture, and show how
many seconds the watch is off — e.g. **`+6 s (fast)`** — to the nearest second, with an
honest uncertainty band. Same calm black-and-white single screen. Nothing leaves the
device; nothing is stored.

This is the spine every v2 slice builds on (camera → `Recognizer` engine → `TimeSync` →
`Drift` → UI), plus the headless Node OCR harness for measuring the decoder against
labelled images.

## Direction (read these first)

- **[`SPEC.md`](SPEC.md)** — the directional north star for v2.
- **[`PLAN.md`](PLAN.md)** — the **design authority**: SPEC's open decisions resolved
  into a committed design (depth-first F-91W robustness via a learned corner detector →
  homography → learned reader, cross-checked by the v1 decoder). Where SPEC and PLAN
  differ, PLAN wins.
- **PRD: [issue #1](https://github.com/SilentKinfolk/watchthedrift-dev/issues/1)** — the
  publishable view, with user stories and acceptance gates. Implementation is sliced
  into `ready-for-agent` issues.
- **[`PROGRESS.md`](PROGRESS.md)** — v1's decoder/capture notes, carried over as baseline
  reference.

## Development

```sh
npm install        # or: npm ci
npm run dev        # http://localhost:5173 (a secure context, so the camera works)
npm test           # unit tests (Vitest): drift, time-sync, parser
npm run build      # type-check (tsc) + production build to dist/
npm run size       # first-load byte-budget gate (run after build; needs dist/)
npm run harness    # run the segment decoder over tools/fixtures + tools/local, score, write overlays
```

> The camera (`getUserMedia`) only works over HTTPS or on `localhost`. Test on a phone
> against the deployed preview URL.
>
> The harness fixtures are CC-licensed Commons photos kept **out** of the repo; re-fetch
> them from the URLs in [`tools/fixtures/CREDITS.md`](tools/fixtures/CREDITS.md) before
> running `npm run harness`.

## Deployment

Pushing to `main` builds the site and deploys it to the **preview** GitHub Pages
environment via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). CI
(typecheck + build + tests + the first-load byte-budget gate) gates every push and PR.

### First-load byte budget (≤ ~5 MB)

watchthedrift is zero-install, so it must stay a light download. CI runs
[`scripts/check-bundle-size.mjs`](scripts/check-bundle-size.mjs) (`npm run size`)
after the build and **fails if the first-load payload exceeds ~5 MB** — the budget
PLAN.md fixes for the on-device models + runtime. The threshold is one constant
(`BUDGET_BYTES`); the pass/fail logic is unit-tested in `scripts/bundle-budget.test.ts`.

**What counts as first-load** (the bytes the browser downloads to show the screen
and do the first reading): the entry `index.html`, the bundled app under
`dist/assets/**` (JS/CSS + any chunks), and any model/runtime asset the app fetches
at runtime that is declared in `EAGER_RUNTIME_ASSETS` (empty until the first model
lands — issue #9 registers it there). Lazy/passthrough files that aren't fetched at
first load — today the *unwired* Tesseract data (`dist/traineddata/`, removed in
issue #11) — don't count, but are listed and **flagged if large**, so a forgotten
eager asset can't silently slip the gate.

## Privacy

All image processing happens **on your device**. The only network request is the time
check. No photos are uploaded, and nothing is stored or logged — every measurement is
ephemeral.

## License

[MIT](LICENSE)
