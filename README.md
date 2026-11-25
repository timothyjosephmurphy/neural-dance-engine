# Neural Dance

A participatory art mural by TJ Murphy / Vermillion Aurora Productions.

A guest sets a unique sticker on the painted floor, and a dancer appears there, moving with the music the phone hears in the room. Pulses climb the legs, travel a seven-node wave up the spine, bloom through the hands at the heart, and leave the crown as a burst that can energize someone else. When the floor is full, those pulses become the visible trace of people connecting.

The live show is at [tjm.art/neural-dance](https://tjm.art/neural-dance/). This repository ([`timothyjosephmurphy/neural-dance-engine`](https://github.com/timothyjosephmurphy/neural-dance-engine)) is the public open-source release of the engine, licensed under the [MIT License](LICENSE).

The engine snapshot here matches the live production build (`0f9f9e3`, PR #149, November 24, 2026), with private studio fixtures and deploy secrets removed. `npm run build` writes pages and assets to `dist/assets`.

A 20-page print edition, *Neural Dance — Under the Hood & Build History*, was prepared on November 23, 2026 for the November 27 gathering. The text, plates, and a compressed PDF are in [docs/book/](docs/book/README.md). The book covers the mural engine through `2b96ea6` (PR #144). The feature list below is current as of the live show.

## How the show works

Seven subsystems share one phone, one projector, and the painted wall.

The phone microphone listens to the room. A silence gate measures the true noise floor and keeps ordinary room sound from stirring the dancers; when the room is quiet, the figures go still. When a song is playing, the signal is split into kick, bass, snare, and hi-hat bands. Each band has its own onset detector. A global tempo lock holds the song’s pulse, and a pattern learner reads meter, downbeat, groove, and phrase. When the neural beat tracker is confident, it drives the steps; when confidence drops, the onset clock keeps time.

The phone camera looks at the mural from an angle, often from a shelf or a tripod off to one side. Four corners of the painted dance floor build a homography that maps the camera’s view onto the stage the projector sees. Once that map is true, a sticker the camera finds is the same point the projector will light.

On the mural show, each guest chooses a unique hand-cut sticker and sets it on the painted floor. The projector holds a clean white field, the camera stores that capture, and the next scan is compared against it, so only something newly placed will spawn a dancer. Shape gates (solidity, circularity, and overlap with dancer-shaped templates) turn away sun discs, ovals, and bright patches on the wall. When a visitor steps in front of the mural, scanning pauses. After they leave and the floor has been clear for a short settle, one automatic scan runs.

Each sticker grows an articulated dancer: hip–knee–ankle and shoulder–elbow–wrist, with planted footwork on the beat. Energy starts in the legs. A pulse climbs the leg chain to the sacrum, then travels a seven-node sine wave up the chakra line — root, sacral, solar plexus, heart, throat, third eye, and crown — colored red through violet. At the heart the pulse branches through the shoulders and out the hands. At the crown, a burst leaves the head and can cross the floor, entering another dancer at the crown and lighting each node on the way down. Stomp ripples and those beams are the living pattern on the painted floor.

The Cloudflare Worker serves the pages at `tjm.art/neural-dance/` and keeps the camera view, the stage, and the projection in register.

A second path, built for the November 27 Paradise Dystopia gathering, runs a scheduled or demo crowd on the same painting: dancers on the floor, the stage, the speakers, and the dome, with a phone remote, live requests, and stage props. The microphone still drives the dancing; the schedule scales density and intensity.

## Features

Current as of the live show, PR #149, main `0f9f9e3`.

**Listening**

- Room microphone with a silence gate tied to the true noise floor
- Kick, bass, snare/mid, and hi-hat onset bands, with SuperFlux-style detectors
- Global tempo lock (about 70–180 BPM, with a preference around 120) and a phase-locked loop
- Pattern learner for tatum, meter (cycles of 2 to 32 steps), swing, and phrase
- Neural beat tracker that takes over once confidence holds, and hands back to the onset clock when it drops
- Song energy and breakdown detection for builds, peaks, and drops
- Melody/pad analyzer (500–4000 Hz) that drives arm reach, so strings and synth lift the hands
- Gap scans between songs on the mural show

**Alignment and vision**

- Off-axis camera-to-projector homography from Auto Align, green calibration marks, the painting frame, or a hand-set quad
- Refine and precision passes (grid fit, structured light, walk check)
- Perspective floor so feet stay planted in the mural’s own space
- White-hold scans with exposure settle; a learned bare-painting reference; gain-matched before-and-after diffs
- Dancer-shape gating (solidity, circularity, aspect, silhouette IoU), ignoring lighting drift and sun bloom
- Person-in-frame pause and a single automatic scan after a visit settles
- OK-hand close-up can request a scan
- Painting-scan fixes from PRs #145–#147: studio visit scans, pause flicker, matte stickers, live-studio white flash, full-frame stills, close-up flash misreads, phantom visits, and weak-edge sticker growth

**Dancers and the chakra engine**

- Articulated skeleton with two-bone inverse kinematics, human bone proportions, and a soft limit so a knee does not lock straight
- Weight shifts, planted footwork, and a library of steps (step-touch, grapevine, box, rock, kick-ball-change, T-step, running man, chasse), switched on phrase boundaries
- Rave and club phrasing on top: two-step and jacking, body waves, heel-toe, kick-and-stomp accents
- Head glance and tilt; melody/pad arms that reach and, at a peak, can travel overhead
- Band tints: warm red and orange for kick and bass, green and yellow for snare and mid, blue and violet for the hats, with a little per-person variation
- Translucent body shell with visible inner bones, so the chakra line stays clear
- Seven-node vibrating string, root to crown, with a traveling sine and lightly pinned beads
- Heart branch through the hands; crown bursts that hop to nearby partners (up to three in a sustained peak, at most two relay hops, then a rest)
- Link radius that follows how spread out the floor is
- Height-field ripples on each dancer’s own stomp, tinted with that dancer’s hue
- Show-arc energy that leans into a peak and eases through a break

**Pages**

- [`/neural-dance/`](https://tjm.art/neural-dance/) — mural page
- [`/neural-dance/live/`](https://tjm.art/neural-dance/live/) — live projector and camera show
- [`/neural-dance/show/`](https://tjm.art/neural-dance/show/) — Paradise Dystopia scheduled crowd show
- [`/neural-dance/demo/`](https://tjm.art/neural-dance/demo/) — crowd demo (no sticker scans; a visit adds one roaming dancer, cap 36)
- [`/neural-dance/show/control/`](https://tjm.art/neural-dance/show/control/) and [`/neural-dance/demo/control/`](https://tjm.art/neural-dance/demo/control/) — phone remote over the studio debug relay
- [`/neural-dance/sim/`](https://tjm.art/neural-dance/sim/) — rehearsal / side simulation
- [`/neural-dance/debug/`](https://tjm.art/neural-dance/debug/) — opt-in debug viewer

**Paradise Dystopia crowd show (PRs #148 and #149)**

- Los Angeles wall-clock schedule, 9 PM–4 AM: the crowd builds, energy rises toward about 3:20 AM, then decays; at 4 AM the floor fades to soft television static until 9 PM
- Speed, jump/scrub, and energy boost on the remote
- Perspective staging on the walkable surfaces of the painting (floor, stage, speakers, dome); stage attraction on mic peaks; fatigue and stamina rest; gated climbing
- Stage light beams that vibrate with the audio bands
- White-capture transitions that can build into a full-white field on a drop, with a 20-minute hard cooldown and a 30-minute force. Stills from the capture stay in the studio debug room.
- Pole (left), cage (right), and a rope swing from the dome top, gated to rested, high-stamina, high-drive dancers. The remote’s pole-spin, cage-shake, and rope buttons run those moves.
- Live request pipeline in the studio Durable Object: a FIFO queue with approve, skip, and kill; an approval toggle; a content filter; one queued request per handle; a cooldown slider; a crowd energy boost that scales with volume; a remote “paste a request” box
- New moves from a deterministic keyword parser built on existing primitives. Each debut gets a front-centre spotlight, runs twice with the handle captioned, plays a unique sting, and joins the persisted library.
- A glowing ETA crystal with no numbers that brightens, then bursts into a wipe
- Hot updates: the projector polls `version.json` and can import `neural-dance/hot/*` without a reload. A core change reloads and restores the crowd behind the wipe.
- Two-tap ROLLBACK on the remote (pins the previous recorded build’s hot set, or `base`) and Unpin, plus a visible build line
- X intake (mentions of `@TJ_de_la_playa` and the Paradise Dystopia hashtag) lives behind flags that default off, with a separate auto-reply flag. It needs Worker secrets that are not set yet.

**Worker, tests, and related source**

- Cloudflare Worker (`worker/index.mjs`), assets from `dist/assets` (see `wrangler.example.toml` and `wrangler.sim.example.toml`)
- Debug rooms are the `NeuralDanceDebugRoom` Durable Object (`worker/neural-dance-debug.mjs`)
- Test suites: `npm run test:node` (unit & synthetic integration tests; fixture-photo tests skip when private studio captures are absent) and `npm run test:show` (with Playwright browser tests)
- The walkable 3D gallery and the Kinoteka Neural Dance annex live in the public repo [`timothyjosephmurphy/gallery-source`](https://github.com/timothyjosephmurphy/gallery-source). The annex is at [tjm.art/play/kinoteka](https://tjm.art/play/kinoteka) and `tjm.art/play/?room=neural-dance`.

## Quick start

Requires Node.js 22+. No runtime npm dependencies are needed for `build` or `test:node`.

```bash
npm run build      # builds pages and assets into dist/assets
npm run test:node  # runs the Node test suite
```

## Self-hosting on Cloudflare Workers

1. Copy `wrangler.example.toml` to `wrangler.toml` (gitignored) and add your own Cloudflare routes or `workers_dev = true`.
2. Build static assets and deploy the Worker:

```bash
npm run build
npx wrangler deploy
```

3. For the optional rehearsal tuning room (`wrangler.sim.example.toml` -> `wrangler.sim.toml`, gitignored), store the write token as a Wrangler secret (see `.env.example`):

```bash
npx wrangler secret put SIM_PARAMS_TOKEN --config wrangler.sim.toml
```

4. If enabling X move requests on the debug room, set `X_BEARER_TOKEN` and `X_USER_ACCESS_TOKEN` with `wrangler secret put` as well. Never commit `wrangler.toml`, `wrangler.sim.toml`, or `.env`.

## The book

[docs/book/README.md](docs/book/README.md) is the markdown text of *Under the Hood & Build History*, with the cover, the five plates, the energy-path and alignment figures, and the 145-commit mural history through PR #144. The compressed print PDF is [docs/book/neural-dance-book-20pp.pdf](docs/book/neural-dance-book-20pp.pdf).

## Repo layout

| Path | What |
| --- | --- |
| `neural-dance/` | Show runtime: listen, align, skeleton, chakras, ripples, crowd, live and debug clients |
| `neural-dance/src/` | Shared show modules |
| `neural-dance/hot/` | Hot-loadable mid-show updates |
| `src/pages/neural-dance/` | Astro sources for the mural, live, and debug pages |
| `static/neural-dance/` | Static pages, including the side sim |
| `worker/` | Worker entry, debug Durable Object, sim params, X intake module |
| `docs/book/` | Print edition text, plates, and PDF |
| `scripts/` | Build, eval, and bench helpers |
| `wrangler.example.toml` | Example Cloudflare Worker config (copy to `wrangler.toml`) |
| `wrangler.sim.example.toml` | Example sim-preview Worker config (copy to `wrangler.sim.toml`) |

## License

Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions. Released under the [MIT License](LICENSE).

- [LICENSE](LICENSE)
- [neural-dance/LICENSE](neural-dance/LICENSE)
- [neural-dance/THIRD_PARTY_NOTICES.md](neural-dance/THIRD_PARTY_NOTICES.md)
- [neural-dance/nn/THIRD_PARTY.md](neural-dance/nn/THIRD_PARTY.md)

## Links

- Live show & info: [tjm.art/neural-dance](https://tjm.art/neural-dance/)
- Art & prints: [tjm.art](https://tjm.art) · [tjm.art/prints](https://tjm.art/prints/)
- Contact / Lightning: `tj@tjm.art`
- X: [@TJ_de_la_playa](https://x.com/TJ_de_la_playa)
