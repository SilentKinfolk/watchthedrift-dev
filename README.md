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

**v2 recognition so far:** the **geometry win** — a learned LCD-corner detector
(`corner-v1`, a ~144 KB int8 tiny-CNN trained by the pure-numpy trainer in
[`tools/train/`](tools/train/), run through the bespoke TS kernel) → homography →
frontal crop → the v1 decoder, combined **precision-first** so it can only add
read-success on angled/off-centre shots, never regress. The corner stage is scored in
isolation and the v1 decoder's confidence is **calibrated** with an abstain threshold
(`npm run harness`). The detector is trained on a thin one-watch corpus, so its
accuracy on the harder eval-gold strata is **data-limited** — corners good on
clean/front-on views, weaker on distant/inverted ones — a known limit routed to the
v2.1 hard-stratum issue (#21); it abstains rather than guessing where it can't.

**v2 capture so far (#12):** the **alignment box is gone** — the app feeds the whole
frame to that corner detector, so there's nothing to line up (this also fixes a
train/serve skew: the detector is trained on whole frames). A scan shows minimal,
honest live feedback (found it / hold steady / glare), and below an ambient-light
floor it **abstains** ("find more light") rather than guess.

**Offline + PWA (#13):** installable, and a service worker caches the app shell + the
corner model (now a build-hashed same-origin asset → atomic app+model versioning), so
**reading works offline**. The time check still needs the network — and offline the app
says **"connect to measure"** rather than ever measuring against the device clock (the
phone clock is exactly the thing that might be wrong).

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
npm test           # unit tests (Vitest): drift, time-sync, parser, eval metric + label schema
npm run build      # type-check (tsc) + production build to dist/
npm run size       # first-load byte-budget gate (run after build; needs dist/)
npm run harness    # decoder precision-first gate + corner-stage isolation eval + calibration + angle-sweep demo, write overlays
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
(typecheck + build + tests + the first-load byte-budget gate + the precision-first
eval gate) gates every push and PR.

### First-load byte budget (≤ ~5 MB)

watchthedrift is zero-install, so it must stay a light download. CI runs
[`scripts/check-bundle-size.mjs`](scripts/check-bundle-size.mjs) (`npm run size`)
after the build and **fails if the first-load payload exceeds ~5 MB** — the budget
PLAN.md fixes for the on-device models + runtime. The threshold is one constant
(`BUDGET_BYTES`); the pass/fail logic is unit-tested in `scripts/bundle-budget.test.ts`.

**What counts as first-load** (the bytes the browser downloads to show the screen
and do the first reading): the entry `index.html`, the bundled app under
`dist/assets/**` (JS/CSS + any chunks — the bespoke inference kernel lands here, no
separate wasm runtime), and any model asset the app fetches at runtime declared in
`EAGER_RUNTIME_ASSETS`. Issue #9 registers `models/**` there: the corner-detector
model + manifest, which `KernelCornerSource` fetches before the first reading — the
trained `corner-v1` int8 tiny-CNN (#11), ~144 KB, so first-load is ~180 KB (3.5% of
budget). Other lazy/passthrough files that aren't fetched at first load don't count,
but are listed and **flagged if large**, so a forgotten eager asset can't silently
slip the gate.

### Precision-first eval gate (confidently-wrong ≤ ~0.5%)

"Honest — fail to a retake rather than guess" is an invariant, so the acceptance
metric **leads with a confidently-wrong ceiling**, not headline accuracy. The
harness (`npm run harness`) scores every read into one of three outcomes — *correct*,
*honest abstain → retake*, or *confidently-wrong* (the cardinal sin) — per
difficulty stratum (easy/moderate/hard) and overall, then evaluates the gate:
confidently-wrong ≤ ~0.5% over the pooled answers. It is **advisory while the eval
set is tiny** (< ~200 samples, where a 0.5% rate is statistically meaningless) and
**fails CI** once the set is large enough and the ceiling is breached. The gate
logic is unit-tested in [`src/eval/metrics.test.ts`](src/eval/metrics.test.ts), so
CI guards it today regardless of how many images are committed. Labels live in a
shared **corner-label sidecar** schema — see
[`docs/eval-labels.md`](docs/eval-labels.md).

## Privacy

All image processing happens **on your device**. The only network request is the time
check. No photos are uploaded, and nothing is stored or logged — every measurement is
ephemeral.

## License

[MIT](LICENSE)
