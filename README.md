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

Mobile/Quest browsers use a 1024×512 field with four noise octaves per layer,
updated at no more than 24 Hz. Desktop uses 2048×1024, five octaves and at most
36 Hz. Eye rendering and head tracking continue at the headset frame rate.
The mobile field draw shades 75% fewer pixels than the previous 2048×1024
pass; this is a workload reduction, not a measured frame-rate claim.
XR resolution scale is 0.85 on mobile, with moderate 0.35 fixed foveation.

The sky reconstructs each eye's world direction from its own inverse
projection using a fullscreen triangle, including asymmetric XR projections.
There is no sphere tessellation. Quintic noise interpolation softens lattice
transitions; faint, antialiased world-space texture is consistent between eyes.
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
