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

## Run

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
