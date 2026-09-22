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

The visual base remains `ef18a44`: five octaves per layer, the palette and
angular gaze wake. Unresolvable high-frequency noise is filtered toward its
mean. The full-screen sky uses each eye's inverse projection; it does not use
a tessellated sphere. Grain is applied after panorama sampling.

### Ordinary Quest Browser page

The corrected report places the blackout **after entering VR and exploring**.
The ordinary-page preview also has a separate conservative budget: at most 30 draws/second and 1280×960 canvas pixels (preserving
aspect ratio). This cap does not limit immersive head tracking. The optional
DeviceOrientation camera and palette animation continue in the preview.

### Bounded background and eye work

Mobile uses a 1024×512 field, four strips, and a maximum 48 strip draws/second.
Only one strip may be submitted per callback, including startup and recovery;
missed work is never submitted in a catch-up burst. This bounds field work at
6.29 million pixels/second; the 30 Hz preview caps it lower still. Five octaves
are retained. Desktop uses a 2048×1024 field and at most 72 strips/second.

Three buffers keep completed snapshots separate from the one being built.
Time, gaze and palette remain fixed within each panorama. Completed snapshots
blend each displayed frame, at the cost of some background animation latency.
Mobile eyes use two total bilinear reads instead of eight cubic reads per
pixel. Desktop retains cubic reconstruction. Mobile XR scale is 0.85, with
fixed foveation disabled. Sustained frame misses halve the field update budget
to 24 strips/second without changing head-pose updates.

### Smooth gradients

Fields use RGBA16F when `EXT_color_buffer_float` is available, avoiding the
8-bit intermediate quantization that can create contour bands in cloud
colour gradients. Three mobile fields require 12 MiB, below the regression's
13.5 MiB of 1536×768 byte fields. If floating-point render targets are unavailable,
the byte field is dithered **before** quantization. Both paths also retain
subtle output grain. This targets colour banding; the reported on-headset
rings still need a device-side comparison to confirm their cause.

### Recovery and diagnostics

Recoverable WebGL context loss exits VR and shows a fallback. Field resources
are disposed while the context is still lost, removing stale Three.js disposal
listeners before restoration; disposing their old framebuffer handles after
restoration had produced INVALID_OPERATION in the XR recovery test. Restored
fields are rebuilt smaller and keep the reduced work budget. Render/shader
exceptions stop the failing loop, show a reload message and record the error. JavaScript cannot
recover an OS-killed browser process or force the browser to restore a context.

Append `?diagnostics=1` to the page URL to show the current and previous run.
`window.flowDiagnostics` exposes the same information for remote inspection.
The version tag is `quest-budget-v3`. Frame progress, texture format, reduced
work status and loss/error events are stored locally every three seconds and
on important events. Nothing is sent to a server. Previous-run data is retained
in memory after reload so a missing loss event can be distinguished from a
reported context loss or JavaScript exception. A missing event alone does not
prove a GPU watchdog reset. The script URL is versioned to avoid testing an
older cached module after deployment.

### Validation

Browser checks cover desktop/mobile shader compilation, matching whole/strip
renders, asymmetric eye projections, simulated context recovery and persisted
recovery diagnostics. A mocked XR session also exercises Three.js’s actual
XRProjectionLayer and XRWebGLLayer paths while turning the head, including
context loss during a session and re-entry after recovery. This checks our
XR integration, but not an actual headset driver or compositor. Supplementary
ordinary-page tests cover 75 seconds of colour changes and 30 seconds on the
byte-texture compatibility path.
These desktop tests do not emulate Quest's GPU, browser compositor or display.

On Quest, enter VR and explore with repeated head turns for at least two
minutes; inspect the broad cloud gradients throughout the panorama.
Check exit/re-entry and browser suspend/resume. If a failure recurs, reload
with diagnostics enabled and inspect the previous run before further reloads.
