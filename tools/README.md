# tools

Developer utilities — not shipped with the app.

## OCR harness

`ocr-harness.ts` runs the F-91W segment decoder (`decodeSegments`, the app's own
recognition pipeline) over a folder of watch images, so we can iterate on accuracy
headlessly and build up labelled test data.

```sh
npm run harness
```

It reads images from:

- `tools/fixtures/` — **licensed** test images (Wikimedia Commons; see
  `fixtures/CREDITS.md` for sources + attribution). The image files themselves are
  gitignored to keep the repo light — re-fetch them from the URLs in CREDITS.
- `tools/local/` — gitignored scratch folder for ad-hoc photos (your own shots,
  debug crops, etc.). Create it and drop images in.

For each image it prints the decoded time and the detected digit cells, and saves
an annotated overlay (the cropped, binarised LCD with its band/cell boxes) to
`tools/out/*-decode.png` — the same view as the in-app `?debug=1`.

### Rectification demo (issue #4)

After the per-image pass it runs the **rectification demo**: it takes the first
fixture the decoder reads head-on, perspective-warps the whole frame into a
synthetic *angled* shot, and compares two paths on it —

- **raw** — `decodeSegments` on the angled frame (v1's perspective-naive path), and
- **rectify** — `rectifyThenDecode` given the LCD's four corners (ground-truth here,
  standing in for the learned corner detector, #9) → a frontal crop, then decode.

The raw path drops the angled shot; the rectify path recovers the time. Overlays
land at `tools/out/rectify-demo-{angled,raw-decode,rectified,rectified-decode}.png`.
This is the harness proof that the rectify→read stage lifts angle/off-centre shots.

### Labelling

The quickest label is in the filename — encode the expected time and the harness
scores it:

```
casio_10-42-15_24h.jpg   → expect 10:42:15, 24-hour mode
something_09-05-30_12h.png → expect 09:05:30, 12-hour mode
```

(`12h` anywhere in the name selects 12-hour parsing; otherwise 24-hour.)

For richer labels — a difficulty **stratum**, the 4 LCD **corners**, provenance —
drop a **corner-label sidecar** beside the image: `foo.jpg` → `foo.jpg.json`. The
sidecar wins where present; the filename is the fallback for the time. This is the
one schema the annotation tool (#8) and the augmentation pipeline (#7) also target
— see [`../docs/eval-labels.md`](../docs/eval-labels.md) for the full schema and the
`easy` / `moderate` / `hard` stratum definitions. Minimal example (stratum only;
time stays on the filename):

```json
{ "version": 1, "stratum": "hard", "eval": true, "note": "faint segment" }
```

> Only commit images you have the right to redistribute. Keep everything else in
> `tools/local/`. **Sidecars are committed** (they are labels, not pixels).

### Precision-first metric + acceptance gate (issue #5)

After the per-image pass the harness prints the **precision-first metrics** — the
three honest outcomes per stratum and overall:

- **correct** — read == truth;
- **abstain → retake** — the decoder declined (no reading). Honest;
- **WRONG** — a confident answer that is wrong. The cardinal sin the gate guards.

It then evaluates the **gate**: confidently-wrong ≤ ~0.5% over the pooled answers.
The gate is **advisory** (reports but never fails) until the eval set crosses ~200
samples — a 0.5% rate is meaningless on a handful of images — and a real FAIL sets a
**non-zero exit**, so `npm run harness` is a CI-failing assertion once enough
committed eval data exists. The gate *logic* is also unit-tested in Vitest, which
runs in CI today.

#### Recorded baseline — v1 decoder over the current fixtures

| stratum | n | correct | abstain | wrong | wrong % |
| --- | --- | --- | --- | --- | --- |
| easy | 1 | 1 | 0 | 0 | 0.0% |
| hard | 2 | 0 | 1 | 1 | 50.0% |
| **overall** | **3** | **1** | **1** | **1** | **33.3%** |

Gate: **ADVISORY** (3 < 200 min samples). The lone confidently-wrong read is the
faint-segment fixture (`19:45:08` mis-read as `19:45:09`, conf 0.71) — the exact
cardinal-sin case the learned reader (#10) must fix; the small-seconds fixture
abstains honestly, and the clean fixture reads correctly. This baseline is what the
rectification stage (#4) and the learned reader (#10) are measured against.
