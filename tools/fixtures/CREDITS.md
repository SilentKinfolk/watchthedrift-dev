# Fixture image credits

Test images of the Casio F-91W, from Wikimedia Commons. All reused under their
Creative Commons licences; attribution below. The image files themselves are
gitignored (the repo stays image-free) — re-fetch them from the Source links, or
re-run `npm run harvest` (see [`../README.md`](../README.md)) and copy the matching
photo to the filename here. Every committed fixture is CC/PD per PLAN "Rights".

| File | Author | Licence | Source |
| --- | --- | --- | --- |
| `f91w-time-noretouch_15-53-08_24h.jpg` | Multicherry | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Casio_F-91W_watch_(2023)_(front_closeup_-_time)_(no_retouch).jpg) |
| `f91w-front-closeup_19-45-08_24h.jpg` | VSchagow | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Casio_F-91_W_front_closeup_minor_retouch.jpg) |
| `f91w-all-segments.jpg` | Multicherry | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Casio_F-91W_watch_(2023)_(front_closeup_-all_segments).jpg) |
| `f91w-5051_06-04-56_12h.jpg` | Ashley Pomeroy | CC BY-SA 3.0 | [Commons](https://commons.wikimedia.org/wiki/File:Casio_F-91W_5051.jpg) |
| `f91w-counterfeit_16-08-53_24h.jpg` | Petar Milošević | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Counterfeit_Casio_F-91W_digital_watch.jpg) |
| `f91w-fulllength_17-00-22_24h.jpg` | Multicherry | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Casio_F-91W_watch_(2023)_(front_view_-_full_length).jpg) |
| `f91w-inverted_20-19-48_24h.jpg` | Multicherry | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Customised_Casio_F-91W_watch_with_inverted_display_(time).jpg) |

## Eval-gold strata (the `eval: true` sidecars)

The committed fixtures double as the held-out **eval gold** the precision gate scores
(`eval: true` in each sidecar). With the issue-#10 harvest the easy/moderate gap is
now filled:

| Stratum | Fixtures | v1 outcome |
| --- | --- | --- |
| **easy** | `counterfeit` (16:08:53) | reads correctly ✓ |
| **moderate** | `fulllength` (17:00:22), `inverted` (20:19:48) | reads the full-length ✓; abstains on the inverted display ∅ (honest) |
| **hard** | `front-closeup` (19:45:08), `5051` (06:04:56) | one confidently-wrong ✗ (the cardinal-sin faint-segment case), one honest abstain ∅ |

`time-noretouch` (15:53:08) is the clean augmentation **seed** (`eval: false`);
`all-segments` carries no real time (a corner/detection card). The hard reals are
the design authority's weighting; #21 hunts more hard reals. Genuinely-hard reals
(faint/glare/small-seconds) cannot be manufactured from the easy-skewed open web.
