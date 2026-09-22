// "Flowing sand" background, ported from samsara's Summary screen
// (Background.svelte) onto a WebXR sky dome.
//
// What changed in the move from a 2D full-screen quad to VR:
//   - The shader reconstructs a sky direction for every eye pixel,
//     so the sand surrounds the viewer instead of sitting behind a page.
//   - The noise field is sampled in 3D on the view direction (the 2D version
//     would need an equirectangular seam somewhere on the dome).
//   - The "hand dragged through sand" pull point is no longer the mouse but
//     where the head is looking: a gaze direction, eased the same way the
//     cursor used to be. Distance from the pull point is angular (radians),
//     which keeps the original 0.6 falloff radius meaningful (~34 degrees).
// Palette drift and the gaze wake retain the original visual direction.
//
// A bounded offscreen field provides the broad flow. The eye pass reconstructs
// world rays from each eye's projection, without a tessellated sky sphere.
// Mobile targets must be small per draw: skipping frames does not reduce a
// GPU watchdog's worst-case draw time.

import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

// Each entry is [shadow, mid, highlight]. All lifted well above the
// original SUMMARY palette (#0e1c2e / #2c4a57 / #bcdce8): the deep teal
// shadows read as a dark stairwell wall, right behind a results panel but
// wrong when the field is all there is around you. Here the darkest stop
// is only a cloud underside, the mid a lit cloud face, the highlight
// sun-through-haze white, so the same flow reads as drifting in cloud.
//
// The tint of that cloud is what changes over time: the shadow and mid
// stops carry the colour of the ground seen from orbit -- open ocean,
// shallows, forest, savanna, desert -- while the highlight stays close to
// white with only a whisper of the same hue. Ordered by hue so each
// neighbour crossfade stays clean (blue -> teal -> green -> yellow-green
// -> ochre); the sequence ping-pongs rather than loops because a direct
// desert -> ocean blend passes through a muddy grey.
// Highlights stop short of white on purpose: a paper-white top stop
// filled too much of the dome and read as glare, so each is a pale tint of
// its own hue, and the shadow/mid stops sit a step darker to match.
const PALETTES = [
	['#2f5677', '#6f97b6', '#c9dceb'], // open ocean
	['#317072', '#78aba8', '#c8e2df'], // shallows / reef
	['#3f6644', '#82a87e', '#cfe0ca'], // forest
	['#767f3d', '#adb37a', '#e3e4c2'], // savanna
	['#96703a', '#c5a577', '#ecdfc4'], // desert
];
// Seconds each terrain holds before the next crossfade, and the length of
// the crossfade itself.
const PALETTE_HOLD = 5;
const PALETTE_FADE = 10;

// Raw 0..1 channels, NOT THREE.Color: with colour management on, Color
// would linearise these sRGB hex values and the whole dome comes out dark
// and low-contrast. The original wrote the hex values straight through,
// and so does the shader here.
function hexToRgb(hex) {
	const n = parseInt(hex.slice(1), 16);
	return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// The pull point is not a single eased gaze any more but a chain of
// followers: link 0 chases the head, link 1 chases link 0, and so on. The
// chain lags behind a turn and settles back along the path the head took,
// so the sand is drawn toward where you have been looking as well as
// where you look now -- a wake rather than a spotlight. Each link chases
// the one ahead at GAZE_EASE per frame (the original mouse easing was
// 0.06; slower here, since the lag is the point). TRAIL_DECAY is how much
// less each link back pulls than the one in front.
const TRAIL_LENGTH = 8;
const GAZE_EASE = 0.035;
const TRAIL_DECAY = 0.78;

const MOBILE = /Quest|Oculus|Android|Mobile/i.test(navigator.userAgent);
const FIELD_WIDTH = MOBILE ? 1536 : 2048;
const FIELD_HEIGHT = FIELD_WIDTH / 2;
// Only one strip is shaded per frame, even during startup and recovery.
// Quest: 1536 * 128 = 196608 heavy pixels, versus 524288 in the black-screen fix.
const FIELD_STRIPS = MOBILE ? 6 : 4;
const FIELD_OCTAVES = 5;

// --- FIELD pass: full-screen triangle into the equirect texture ---------

const fieldVertex = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = vec4(position.xy, 0.0, 1.0);
	}
`;

const fieldFragment = /* glsl */ `
	precision highp float;

	#define TRAIL_LENGTH ${TRAIL_LENGTH}

	uniform float uTime;
	uniform vec3 uTrail[TRAIL_LENGTH];
	uniform float uTrailWeight[TRAIL_LENGTH];
	uniform vec3 uColorDark;
	uniform vec3 uColorMid;
	uniform vec3 uColorLight;

	varying vec2 vUv;

	float hash3(vec3 p) {
		p = fract(p * vec3(123.34, 456.21, 789.12));
		p += dot(p, p.yzx + 45.32);
		return fract((p.x + p.y) * p.z);
	}

	float noise(vec3 p) {
		vec3 i = floor(p);
		vec3 f = fract(p);
		vec3 u = f * f * (3.0 - 2.0 * f);
		float n000 = hash3(i);
		float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
		float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
		float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
		float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
		float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
		float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
		float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
		return mix(
			mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
			mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
			u.z
		);
	}

	float fbm(vec3 p) {
		float value = 0.0;
		float amplitude = 0.5;
		float footprint = max(length(dFdx(p)), length(dFdy(p)));
		for (int i = 0; i < ${FIELD_OCTAVES}; i++) {
			// Keep the reference's five octaves and their average brightness.
			// Fade only frequencies the field texels cannot resolve, notably
			// in the compressed gaze wake. Dropping them darkens the cloud.
			float resolved = 1.0 - smoothstep(0.35, 0.85, footprint);
			value += amplitude * mix(0.5, noise(p), resolved);
			p *= 2.0;
			footprint *= 2.0;
			amplitude *= 0.5;
		}
		return value;
	}

	void main() {
		// texel -> world direction; u wraps around the horizon, v runs
		// pole to pole. u = 0.5 is straight ahead (-Z), matching the
		// lookup in the dome pass.
		float lon = (vUv.x - 0.5) * 6.28318530718;
		float lat = (vUv.y - 0.5) * 3.14159265359;
		vec3 dir = vec3(cos(lat) * sin(lon), sin(lat), -cos(lat) * cos(lon));

		// angular distance from each point along the recent gaze path pulls
		// the flow field toward it, like a hand dragged through sand: the
		// current gaze pulls hardest, older links along the path less, so
		// a turn of the head leaves a wake that closes up behind it
		float pull = 0.0;
		vec3 drag = vec3(0.0);
		for (int i = 0; i < TRAIL_LENGTH; i++) {
			vec3 g = uTrail[i];
			// Restore ef18a44's angular falloff, with defined smoothstep edges.
			float d = acos(clamp(dot(dir, g), -1.0, 1.0));
			float p = (1.0 - smoothstep(0.0, 0.6, d)) * uTrailWeight[i];
			pull += p;
			drag += (dir - g) * p;
		}
		pull = min(pull, 1.0);

		vec3 flow = dir * 3.0;
		// Which patch of the lattice the dome starts on decides how the
		// first minute reads (the hash is far from uniform on small integer
		// cells). This offset was searched so the forward view opens with
		// the same dark/light balance the screen version had at t=0.
		flow += vec3(11.9, 11.7, 0.0);
		// slower than the original 0.03 / 0.02: with the wake carrying the
		// motion, the field itself only needs to breathe
		flow += vec3(uTime * 0.018, uTime * 0.012, 0.0);
		flow += drag * 1.5;

		float n = fbm(flow);
		n += fbm(flow * 2.0 + 10.0) * 0.5;
		// Trilinear 3D value noise is a touch flatter than the bilinear 2D
		// noise it replaces (sd 0.119 vs 0.138 over the same octave layout,
		// same mean 0.725). Only partly compensated here: cloud wants soft
		// edges more than it wants the screen version's deep pockets.
		n = 0.725 + (n - 0.725) * 1.08;

		// Light from above: the field brightens toward the zenith and cools
		// slightly toward the nadir, so there is an up and a down to float
		// in rather than a uniform fog. +-0.06 on n is enough to read.
		float sky = dir.y * 0.5 + 0.5;
		n += (sky - 0.5) * 0.12;

		// Wider, overlapping ramps than the original's (0.2-0.6, 0.55-0.85):
		// cloud has no hard shadow line, so shadow-to-mid and mid-to-light
		// both spread across most of the range and blend into each other.
		// The light ramp starts later and the gaze bonus is smaller than
		// before (0.62-0.95 and 0.25): the highlight should be the crest
		// of a cloud, not the bulk of it.
		vec3 color = mix(uColorDark, uColorMid, smoothstep(0.35, 0.75, n));
		color = mix(color, uColorLight, smoothstep(0.72, 1.0, n + pull * 0.18));
		// Faint cool tint in the shadow undersides, so they read as blue
		// sky showing through rather than grey.
		color = mix(color, color * vec3(0.97, 0.99, 1.03), 1.0 - smoothstep(0.35, 0.75, n));

		gl_FragColor = vec4(color, 1.0);
	}
`;

// --- DOME pass: what the eyes see -----------------------------------------

const domeVertex = /* glsl */ `
	uniform mat4 uInverseProjection;
	uniform mat4 uEyeWorld;
	varying highp vec3 vDir;
	void main() {
		vec4 ray = uInverseProjection * vec4(position.xy, 1.0, 1.0);
		vDir = mat3(uEyeWorld) * (ray.xyz / ray.w);
		gl_Position = vec4(position.xy, 1.0, 1.0);
	}
`;

const domeFragment = /* glsl */ `
	precision highp float;

	uniform sampler2D uField;
	uniform sampler2D uPreviousField;
	uniform vec2 uFieldSize;
	uniform float uFieldBlend;
	uniform float uTime;

	varying highp vec3 vDir;

	float hash(vec2 p) {
		p = fract(p * vec2(123.34, 456.21));
		p += dot(p, p + 45.32);
		return fract(p.x * p.y);
	}

	// Cubic B-spline reconstruction: four hardware-bilinear reads replace
	// a 16-texel kernel (GPU Gems 2, chapter 20). RepeatWrapping preserves
	// continuity at the longitude seam. Positive weights avoid ringing.
	vec3 sampleField(sampler2D tex, vec2 uv) {
		vec2 p = uv * uFieldSize - 0.5;
		vec2 base = floor(p);
		vec2 f = fract(p);
		vec2 f2 = f * f;
		vec2 f3 = f2 * f;
		vec2 w0 = (1.0 - 3.0*f + 3.0*f2 - f3) / 6.0;
		vec2 w1 = (4.0 - 6.0*f2 + 3.0*f3) / 6.0;
		vec2 w2 = (1.0 + 3.0*f + 3.0*f2 - 3.0*f3) / 6.0;
		vec2 w3 = f3 / 6.0;
		vec2 g0 = w0 + w1;
		vec2 g1 = w2 + w3;
		vec2 a = (base - 0.5 + w1 / g0) / uFieldSize;
		vec2 b = (base + 1.5 + w3 / g1) / uFieldSize;
		return mix(
			mix(texture2D(tex, a).rgb, texture2D(tex, vec2(b.x, a.y)).rgb, g1.x),
			mix(texture2D(tex, vec2(a.x, b.y)).rgb, texture2D(tex, b).rgb, g1.x),
			g1.y);
	}

	void main() {
		vec3 dir = normalize(vDir);
		// inverse of the field pass mapping; the texture wraps in u so the
		// atan seam at +-PI is invisible
		vec2 uv = vec2(
			atan(dir.x, -dir.z) / 6.28318530718 + 0.5,
			asin(clamp(dir.y, -1.0, 1.0)) / 3.14159265359 + 0.5
		);
		// Only complete snapshots are shown; the texture under construction
		// is never sampled by either eye. Interpolation runs every eye frame.
		vec3 color = mix(sampleField(uPreviousField, uv), sampleField(uField, uv), uFieldBlend);
		// Restore an organic, low-amplitude grain instead of periodic sine
		// stripes. Grain is added after reconstruction, never magnified.
		color += (hash(gl_FragCoord.xy + uTime) - 0.5) * 0.008;

		gl_FragColor = vec4(color, 1.0);
	}
`;

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MOBILE ? 1 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// Palette values are sRGB hex and the original wrote them straight to the
// canvas; leave them alone rather than letting three re-encode them.
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
// The expensive field is budgeted separately. Preserve eye resolution
// and avoid foveation tile boundaries across this smooth, continuous sky.
renderer.xr.setFramebufferScaleFactor(1);
renderer.xr.setFoveation(0);
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));
const fallback = document.getElementById('fallback');
const status = document.getElementById('status');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);

const uniforms = {
	uTime: { value: 0 },
	uTrail: { value: Array.from({ length: TRAIL_LENGTH }, () => new THREE.Vector3(0, 0, -1)) },
	uTrailWeight: { value: Array.from({ length: TRAIL_LENGTH }, (_, i) => Math.pow(TRAIL_DECAY, i)) },
	uColorDark: { value: new THREE.Vector3() },
	uColorMid: { value: new THREE.Vector3() },
	uColorLight: { value: new THREE.Vector3() },
};

// ---------------------------------------------------------------------------
// Palette drift
// ---------------------------------------------------------------------------

const PALETTE_RGB = PALETTES.map(p => p.map(hexToRgb));
// 0 1 2 3 4 3 2 1, then repeat -- see the note on PALETTES for why.
const PALETTE_ORDER = [
	...PALETTES.map((_, i) => i),
	...PALETTES.map((_, i) => i).slice(1, -1).reverse(),
];
const PALETTE_SEGMENT = PALETTE_HOLD + PALETTE_FADE;
const _stop = new THREE.Vector3();

function updatePalette(seconds) {
	const seg = Math.floor(seconds / PALETTE_SEGMENT);
	const phase = seconds - seg * PALETTE_SEGMENT;
	const from = PALETTE_RGB[PALETTE_ORDER[seg % PALETTE_ORDER.length]];
	const to = PALETTE_RGB[PALETTE_ORDER[(seg + 1) % PALETTE_ORDER.length]];
	// smoothstep across the fade so the hold on either side eases in and
	// out instead of the tint visibly starting and stopping.
	let t = THREE.MathUtils.clamp((phase - PALETTE_HOLD) / PALETTE_FADE, 0, 1);
	t = t * t * (3 - 2 * t);
	const targets = [uniforms.uColorDark, uniforms.uColorMid, uniforms.uColorLight];
	for (let i = 0; i < 3; i++) {
		targets[i].value.copy(from[i]).lerp(_stop.copy(to[i]), t);
	}
}
updatePalette(0);

const createFieldTarget = () => new THREE.WebGLRenderTarget(FIELD_WIDTH, FIELD_HEIGHT, {
	depthBuffer: false,
	stencilBuffer: false,
	wrapS: THREE.RepeatWrapping,
	wrapT: THREE.ClampToEdgeWrapping,
	minFilter: THREE.LinearFilter,
	magFilter: THREE.LinearFilter,
	generateMipmaps: false,
});
const fieldTargets = Array.from({ length: 3 }, createFieldTarget);
let [previousField, currentField, writingField] = fieldTargets;
const fieldUniforms = THREE.UniformsUtils.clone(uniforms);
let fieldStrip = 0;
let fieldReady = false;
let fieldBlendStart = 0;
let fieldCycleStart = 0;
let fieldBlendDuration = FIELD_STRIPS / 72;
const fieldScene = new THREE.Scene();
const fieldCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
fieldScene.add(new THREE.Mesh(
	new THREE.PlaneGeometry(2, 2),
	new THREE.ShaderMaterial({
		vertexShader: fieldVertex,
		fragmentShader: fieldFragment,
		uniforms: fieldUniforms,
		depthWrite: false,
		depthTest: false,
	})
));

const dome = new THREE.Mesh(
	new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([
		-1, -1, 0, 3, -1, 0, -1, 3, 0,
	], 3)),
	new THREE.ShaderMaterial({
		vertexShader: domeVertex,
		fragmentShader: domeFragment,
		uniforms: {
			uField: { value: currentField.texture },
			uPreviousField: { value: previousField.texture },
			uFieldSize: { value: new THREE.Vector2(FIELD_WIDTH, FIELD_HEIGHT) },
			uFieldBlend: { value: 1 },
			uInverseProjection: { value: new THREE.Matrix4() },
			uEyeWorld: { value: new THREE.Matrix4() },
			uTime: uniforms.uTime,
		},
		side: THREE.FrontSide,
		depthWrite: false,
		depthTest: false,
	})
);
dome.frustumCulled = false;
// Three calls this separately for each XR eye, including asymmetric frusta.
dome.onBeforeRender = (_renderer, _scene, eye) => {
	dome.material.uniforms.uInverseProjection.value.copy(eye.projectionMatrixInverse);
	dome.material.uniforms.uEyeWorld.value.copy(eye.matrixWorld);
	dome.material.uniformsNeedUpdate = true;
};
scene.add(dome);

// ---------------------------------------------------------------------------
// Head orientation
//
// In an XR session the pose comes from the headset via three's XR camera.
// Outside one, phones can supply the same thing through DeviceOrientation,
// which is mapped onto the camera below so the dome reacts to the phone
// being turned. A desktop browser without a headset gets neither -- the
// gaze just stays fixed forward and the sand drifts on its own.
// ---------------------------------------------------------------------------

const gazeTarget = new THREE.Vector3(0, 0, -1);
const trail = uniforms.uTrail.value;

const orient = {
	active: false,
	alpha: 0, beta: 0, gamma: 0,
	screen: 0,
};
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 about X
const _zee = new THREE.Vector3(0, 0, 1);

function applyDeviceOrientation(target) {
	const alpha = THREE.MathUtils.degToRad(orient.alpha);
	const beta = THREE.MathUtils.degToRad(orient.beta);
	const gamma = THREE.MathUtils.degToRad(orient.gamma);
	const screen = THREE.MathUtils.degToRad(orient.screen);
	_euler.set(beta, alpha, -gamma, 'YXZ');
	target.setFromEuler(_euler);
	target.multiply(_q1);
	target.multiply(_q0.setFromAxisAngle(_zee, -screen));
}

function onDeviceOrientation(e) {
	if (e.alpha == null) return;
	orient.active = true;
	orient.alpha = e.alpha;
	orient.beta = e.beta;
	orient.gamma = e.gamma;
	orient.screen = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
}

const orientButton = document.getElementById('orient');
function startDeviceOrientation() {
	window.addEventListener('deviceorientation', onDeviceOrientation);
	orientButton.style.display = 'none';
}
// Only worth wiring up on a device that can actually be turned around;
// desktop Safari exposes the same API but never fires it.
if (typeof DeviceOrientationEvent !== 'undefined' && navigator.maxTouchPoints > 0) {
	if (typeof DeviceOrientationEvent.requestPermission === 'function') {
		// iOS: needs a gesture first.
		orientButton.style.display = 'block';
		orientButton.addEventListener('click', () => {
			DeviceOrientationEvent.requestPermission()
				.then(state => { if (state === 'granted') startDeviceOrientation(); })
				.catch(() => {});
		});
	} else {
		startDeviceOrientation();
	}
}

renderer.xr.addEventListener('sessionstart', () => { orientButton.style.display = 'none'; });

// ---------------------------------------------------------------------------

function resize() {
	if (renderer.xr.isPresenting) return;
	renderer.setSize(window.innerWidth, window.innerHeight);
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

let lastTime = null;
let elapsed = 0;
let contextLost = false;
let recoveries = 0;

renderer.domElement.addEventListener('webglcontextlost', event => {
	event.preventDefault();
	contextLost = true;
	fallback.hidden = false;
	renderer.domElement.style.visibility = 'hidden';
	status.textContent = 'Graphics interrupted. Recovering…';
	status.hidden = false;
	// DOM recovery is only visible outside immersive mode.
	const session = renderer.xr.getSession();
	if (session) session.end().catch(console.warn);
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
	// Three restores its resources first; rebuild the field on the next frame.
	recoveries++;
	for (const target of fieldTargets) {
		target.setSize(Math.max(512, FIELD_WIDTH >> Math.min(recoveries, 2)),
			Math.max(256, FIELD_HEIGHT >> Math.min(recoveries, 2)));
	}
	dome.material.uniforms.uFieldSize.value.set(currentField.width, currentField.height);
	fieldStrip = 0;
	fieldReady = false;
	contextLost = false;
	lastTime = null;
});
document.addEventListener('visibilitychange', () => { lastTime = null; });
renderer.xr.addEventListener('sessionend', () => { resize(); lastTime = null; });

renderer.setAnimationLoop(time => {
	if (contextLost) return;
	// In immersive mode use XR visibility; the 2D document may be hidden.
	if (renderer.xr.isPresenting) {
		if (renderer.xr.getSession().visibilityState === 'hidden') return;
	} else if (document.hidden) return;
	const dt = lastTime === null ? 1 / 72 : Math.min(Math.max((time - lastTime) / 1000, 0), 0.05);
	lastTime = time;
	elapsed += dt;
	let head = camera;
	if (renderer.xr.isPresenting) {
		renderer.xr.updateCamera(camera);
		head = renderer.xr.getCamera();
	} else if (orient.active) {
		applyDeviceOrientation(camera.quaternion);
	}
	head.getWorldDirection(gazeTarget);
	let ahead = gazeTarget;
	const ease = 1 - Math.pow(1 - GAZE_EASE, dt * 72);
	for (let i = 0; i < TRAIL_LENGTH; i++) {
		trail[i].lerp(ahead, ease).normalize();
		ahead = trail[i];
	}
	uniforms.uTime.value = elapsed;
	updatePalette(elapsed);

	// Freeze all inputs for an entire panorama so strip boundaries cannot
	// expose different gaze poses, animation times or palette colours.
	if (fieldStrip === 0) {
		fieldCycleStart = elapsed - dt;
		fieldUniforms.uTime.value = uniforms.uTime.value;
		for (let i = 0; i < TRAIL_LENGTH; i++) fieldUniforms.uTrail.value[i].copy(trail[i]);
		for (const name of ['uColorDark', 'uColorMid', 'uColorLight']) {
			fieldUniforms[name].value.copy(uniforms[name].value);
		}
	}
	const rowStart = Math.floor(fieldStrip * writingField.height / FIELD_STRIPS);
	const rowEnd = Math.floor((fieldStrip + 1) * writingField.height / FIELD_STRIPS);
	writingField.scissor.set(0, rowStart, writingField.width, rowEnd - rowStart);
	writingField.scissorTest = true;
	const xrWasEnabled = renderer.xr.enabled;
	const eyeTarget = renderer.getRenderTarget();
	const face = renderer.getActiveCubeFace();
	const mip = renderer.getActiveMipmapLevel();
	try {
		renderer.xr.enabled = false;
		renderer.setRenderTarget(writingField);
		renderer.render(fieldScene, fieldCamera);
	} finally {
		renderer.setRenderTarget(eyeTarget, face, mip);
		renderer.xr.enabled = xrWasEnabled;
	}
	if (++fieldStrip === FIELD_STRIPS) {
		const spare = previousField;
		previousField = currentField;
		currentField = writingField;
		writingField = spare;
		const eyeUniforms = dome.material.uniforms;
		eyeUniforms.uField.value = currentField.texture;
		eyeUniforms.uPreviousField.value = fieldReady ? previousField.texture : currentField.texture;
		fieldBlendStart = elapsed;
		fieldBlendDuration = Math.max(elapsed - fieldCycleStart, 1 / 120);
		fieldReady = true;
		fieldStrip = 0;
	}
	// Keep the page's fallback until the first complete field is available.
	if (!fieldReady) return;
	dome.material.uniforms.uFieldBlend.value = THREE.MathUtils.clamp(
		(elapsed - fieldBlendStart) / fieldBlendDuration, 0, 1);

	renderer.render(scene, camera);
	renderer.domElement.style.visibility = 'visible';
	fallback.hidden = true;
	status.hidden = true;
});
