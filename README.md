# Flowing Sand — WebXR

The "flowing sand" shader background from samsara's Summary screen
(`src/lib/components/Background.svelte`), rebuilt as a WebXR sky dome.
Only the visual effect is carried over — no game logic, text, or UI.

The pull point that used to follow the mouse now follows **head orientation**:
look somewhere and the sand there is drawn toward your gaze.

The tint drifts over time through satellite-view terrain colours (open ocean
→ shallows → forest → savanna → desert and back), holding each for 5 s and
crossfading over 10 s. See `PALETTES`, `PALETTE_HOLD`, `PALETTE_FADE` in
`sand.js`.

## Live

https://marcwong.github.io/samsara_vr/ — served over https, so it opens
directly in a headset browser.

## Run locally

Any static server works. WebXR needs a secure context (`https://` or
`localhost`):

```bash
npx serve .
```

- **Headset (Quest etc.)**: open the page in the headset browser and press
  *Enter VR*. For a headset on the same network use an https tunnel, or
  `adb reverse tcp:3000 tcp:3000` so `http://localhost:3000` works on-device.
- **Phone**: gaze comes from DeviceOrientation. iOS shows an *Enable head
  tracking* tap first.
- **Desktop without a headset**: the sand still drifts but the gaze stays
  fixed forward. The *Immersive Web Emulator* browser extension can simulate
  a headset for testing.

## Files

- `index.html` — page shell + import map (three.js 0.185.1 from jsDelivr)
- `sand.js` — shader, dome, head tracking

## Quest rendering and recovery

The visual reference is `ef18a44f558de35f2753b94fe94bdc46ae8d4cb4`:
its five octaves per noise layer, cubic noise interpolation, angular gaze
falloff, palette, drift and highlight shaping are retained. Frequencies too
fine for the field texture fade toward their mean, rather than disappearing
and darkening the clouds. Fine grain is reduced to 0.008 and added at eye
resolution; the periodic sine texture from the first black-screen fix is gone.

Quest/mobile uses a 1536×768 field, built in six horizontal strips. Desktop
uses 2048×1024 in four strips. Only one strip is shaded each frame, including
startup and recovery. Quest therefore shades 196,608 heavy pixels per draw,
compared with 524,288 in the first black-screen fix. This bounds the peak draw;
it does not imply lower total GPU cost or a measured frame-rate improvement.

Three buffers separate the previous, current and in-progress snapshots. Time,
trail and palette inputs are frozen throughout each build, so strips meet
without temporal seams. Only complete panoramas are displayed. Both eyes use
the same blend between completed snapshots on every frame. At 72 Hz the Quest
field completes 12 snapshots/second; blending adds roughly one snapshot of
latency to the slowly evolving field. Head pose itself is rendered every frame.

The eye shader uses cubic B-spline reconstruction (four bilinear reads per
snapshot) to soften magnified texel boundaries without overshoot. The sky
reconstructs each eye's world direction from its own inverse projection,
including asymmetric XR projections, without sphere tessellation. Eye scale
is 1.0 and fixed foveation is disabled to avoid peripheral tiles. These quality
improvements add eye-pass cost and require Quest performance validation.
This remains a procedural sky, not a volumetric scene with motion parallax.

On recoverable WebGL context loss, the page exits VR, shows a recovery message,
and rebuilds the field at reduced resolution after the browser restores the
context. Enter VR again after recovery. A browser process killed by the OS
cannot be recovered by JavaScript; reload the page in that case.

### Headset acceptance checks

- Open the page in Quest Browser and leave it running for at least five minutes.
- Enter VR, look around and up/down, and check the panorama seam and both eyes.
- Turn quickly: the view must track every frame while the flow wake eases behind.
- Exit/re-enter VR and suspend/resume the browser. Check that rendering continues.
- Record headset frame times and any browser/GPU errors if blackouts persist.

Desktop automation cannot establish Quest GPU performance or headset comfort.

### Local validation of the quality revision

- Chrome renders the desktop and Quest user-agent configurations without
  JavaScript or shader errors; both simulated asymmetric eye projections draw.
- A frozen field rendered in six strips matches a full draw byte-for-byte.
- Simulated WebGL context loss restores both configurations at reduced size.
- In a fixed forward view at time zero, the revised Quest field differs from
  the reference by an average 0.87 per RGB channel on a 0–255 scale. This checks
  broad visual fidelity, not headset aliasing, motion comfort or performance.
