# tools

Developer utilities — not shipped with the app.

## OCR harness

`ocr-harness.ts` runs the recognition pipeline (the app's own `binarize` +
`parseTime`) over a folder of watch images, so we can iterate on accuracy
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

For each image it prints what OCR returns from the **raw** image and from the
**binarised** image, and the parsed time.

### Labelling

Encode the expected time in the filename to have the harness score it:

```
casio_10-42-15_24h.jpg   → expect 10:42:15, 24-hour mode
something_09-05-30_12h.png → expect 09:05:30, 12-hour mode
```

(`12h` anywhere in the name selects 12-hour parsing; otherwise 24-hour.)

> Only commit images you have the right to redistribute. Keep everything else in
> `tools/local/`.
