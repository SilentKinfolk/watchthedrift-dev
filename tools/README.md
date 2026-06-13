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

Encode the expected time in the filename to have the harness score it:

```
casio_10-42-15_24h.jpg   → expect 10:42:15, 24-hour mode
something_09-05-30_12h.png → expect 09:05:30, 12-hour mode
```

(`12h` anywhere in the name selects 12-hour parsing; otherwise 24-hour.)

> Only commit images you have the right to redistribute. Keep everything else in
> `tools/local/`.
