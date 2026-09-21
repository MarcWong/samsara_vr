// "Flowing sand" background, ported from samsara's Summary screen
// (Background.svelte) onto a WebXR sky dome.
//
// What changed in the move from a 2D full-screen quad to VR:
//   - The shader is drawn on the inside of a sphere that follows the head,
//     so the sand surrounds the viewer instead of sitting behind a page.
//   - The noise field is sampled in 3D on the view direction (the 2D version
//     would need an equirectangular seam somewhere on the dome).
//   - The "hand dragged through sand" pull point is no longer the mouse but
//     where the head is looking: a gaze direction, eased the same way the
//     cursor used to be. Distance from the pull point is angular (radians),
//     which keeps the original 0.6 falloff radius meaningful (~34 degrees).
// Everything else -- drift speed, octave layout, grain, palette and the
// three-stop colour mix -- is the same as the original.

import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

// [shadow, mid, highlight]. Lifted well above the original SUMMARY palette
// (#0e1c2e / #2c4a57 / #bcdce8): the deep teal shadows read as a dark
// stairwell wall, which is right behind a results panel but wrong when the
// field is all there is around you. Here the darkest stop is only a
// blue-grey cloud underside, the mid is a lit cloud face and the highlight
// is sun-through-haze white, so the same flow reads as drifting in cloud.
const PALETTE = ['#6c8ba0', '#b3cbd8', '#f3f8fb'];

// Raw 0..1 channels, NOT THREE.Color: with colour management on, Color
// would linearise these sRGB hex values and the whole dome comes out dark
// and low-contrast. The original wrote the hex values straight through,
// and so does the shader here.
function hexToRgb(hex) {
	const n = parseInt(hex.slice(1), 16);
	return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Rate the gaze target is chased per frame; the original mouse easing.
const GAZE_EASE = 0.06;

// The dome is a screen's worth of fbm at VR resolution x2 eyes, and the
// look is grainy by design, so rendering below native and letting the
// compositor upscale costs nothing visible.
const XR_FRAMEBUFFER_SCALE = 0.8;

const vertex = /* glsl */ `
	varying vec3 vDir;
	void main() {
		// Sphere is centred on the head and never rotated, so the object-space
		// vertex direction is the world-space view direction of that texel.
		vDir = position;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}
`;

const fragment = /* glsl */ `
	precision highp float;

	uniform float uTime;
	uniform vec3 uGaze;
	uniform vec3 uColorDark;
	uniform vec3 uColorMid;
	uniform vec3 uColorLight;

	varying vec3 vDir;

	float hash(vec2 p) {
		p = fract(p * vec2(123.34, 456.21));
		p += dot(p, p + 45.32);
		return fract(p.x * p.y);
	}

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
		for (int i = 0; i < 5; i++) {
			value += amplitude * noise(p);
			p *= 2.0;
			amplitude *= 0.5;
		}
		return value;
	}

	void main() {
		vec3 dir = normalize(vDir);
		vec3 gaze = normalize(uGaze);

		// angular distance from where the head is looking pulls the flow
		// field toward it, like a hand dragged through sand
		float d = acos(clamp(dot(dir, gaze), -1.0, 1.0));
		float pull = smoothstep(0.6, 0.0, d);

		vec3 flow = dir * 3.0;
		// Which patch of the lattice the dome starts on decides how the
		// first minute reads (the hash is far from uniform on small integer
		// cells). This offset was searched so the forward view opens with
		// the same dark/light balance the screen version had at t=0.
		flow += vec3(11.9, 11.7, 0.0);
		flow += vec3(uTime * 0.03, uTime * 0.02, 0.0);
		flow += (dir - gaze) * pull * 1.5;

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

		// Half the original grain; on a pale field the full 0.04 reads as
		// dust rather than the texture it gave the dark version.
		float grain = (hash(gl_FragCoord.xy + uTime) - 0.5) * 0.02;

		// Wider, overlapping ramps than the original's (0.2-0.6, 0.55-0.85):
		// cloud has no hard shadow line, so shadow-to-mid and mid-to-light
		// both spread across most of the range and blend into each other.
		vec3 color = mix(uColorDark, uColorMid, smoothstep(0.35, 0.75, n));
		color = mix(color, uColorLight, smoothstep(0.62, 0.95, n + pull * 0.25));
		// Faint cool tint in the shadow undersides, so they read as blue
		// sky showing through rather than grey.
		color = mix(color, color * vec3(0.97, 0.99, 1.03), 1.0 - smoothstep(0.35, 0.75, n));
		color += grain;

		gl_FragColor = vec4(color, 1.0);
	}
`;

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// Palette values are sRGB hex and the original wrote them straight to the
// canvas; leave them alone rather than letting three re-encode them.
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
renderer.xr.setFramebufferScaleFactor(XR_FRAMEBUFFER_SCALE);
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));
document.getElementById('fallback').remove();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);

const uniforms = {
	uTime: { value: 0 },
	uGaze: { value: new THREE.Vector3(0, 0, -1) },
	uColorDark: { value: hexToRgb(PALETTE[0]) },
	uColorMid: { value: hexToRgb(PALETTE[1]) },
	uColorLight: { value: hexToRgb(PALETTE[2]) },
};

const dome = new THREE.Mesh(
	new THREE.SphereGeometry(20, 48, 32),
	new THREE.ShaderMaterial({
		vertexShader: vertex,
		fragmentShader: fragment,
		uniforms,
		side: THREE.BackSide,
		depthWrite: false,
		depthTest: false,
	})
);
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
const gazeEased = new THREE.Vector3(0, 0, -1);
const headPos = new THREE.Vector3();

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

const timer = new THREE.Timer();

renderer.setAnimationLoop(() => {
	let head = camera;
	if (renderer.xr.isPresenting) {
		head = renderer.xr.getCamera();
	} else if (orient.active) {
		applyDeviceOrientation(camera.quaternion);
	}

	head.getWorldDirection(gazeTarget);
	head.getWorldPosition(headPos);
	dome.position.copy(headPos);

	// same chase the mouse point had, done on the direction vector
	gazeEased.lerp(gazeTarget, GAZE_EASE).normalize();

	timer.update();
	uniforms.uTime.value = timer.getElapsed();
	uniforms.uGaze.value.copy(gazeEased);

	renderer.render(scene, camera);
});
