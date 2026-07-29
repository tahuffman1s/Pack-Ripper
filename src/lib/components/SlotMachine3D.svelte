<script>
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { REELS, STOPS, SYMBOLS } from '$lib/slots.js';

	let { onlanded = () => {}, onnowebgl = () => {} } = $props();

	let host = $state();
	let noWebGL = $state(false);

	// Each reel is a drum of STOPS flat panels arranged around the X axis — the
	// same construction as a mechanical reel strip, and it keeps every symbol
	// upright and legible without wrestling with cylinder UVs.
	const RADIUS = 2.5;
	const REEL_W = 1.6;
	const GAP = 0.14;
	const ANGLE_PER_STOP = (Math.PI * 2) / STOPS;
	const CELL_H = (Math.PI * 2 * RADIUS) / STOPS;

	/** Rotation that brings `stop` to the front of the window (theta = PI/2). */
	const angleForStop = (stop) => Math.PI / 2 - stop * ANGLE_PER_STOP;

	/** One symbol face, drawn upright. */
	function faceTexture(id) {
		const W = 256;
		const H = 168;
		const c = document.createElement('canvas');
		c.width = W;
		c.height = H;
		const x = c.getContext('2d');
		const sym = SYMBOLS[id];

		const g = x.createLinearGradient(0, 0, 0, H);
		g.addColorStop(0, '#fbfdff');
		g.addColorStop(0.5, '#e6ecf5');
		g.addColorStop(1, '#c7d2de');
		x.fillStyle = g;
		x.fillRect(0, 0, W, H);

		x.strokeStyle = 'rgba(15,23,42,0.28)';
		x.lineWidth = 6;
		x.strokeRect(0, 0, W, H);

		const cx = W / 2;
		const cy = H / 2;
		const rr = H * 0.34;
		x.beginPath();
		x.arc(cx, cy, rr, 0, Math.PI * 2);
		x.fillStyle = sym.color;
		x.fill();
		x.lineWidth = 6;
		x.strokeStyle = 'rgba(15,23,42,0.5)';
		x.stroke();

		x.font = `bold ${Math.round(rr * 1.2)}px system-ui, "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
		x.textAlign = 'center';
		x.textBaseline = 'middle';
		x.fillStyle = sym.text;
		x.fillText(sym.glyph, cx, cy + rr * 0.05);

		const tex = new THREE.CanvasTexture(c);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = 8;
		return tex;
	}

	let api = { spinTo: () => {} };
	export function spinTo(stops) {
		api.spinTo(stops);
	}

	onMount(() => {
		const W = host.clientWidth;
		const H = host.clientHeight;

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 100);
		camera.position.set(0, 0, 12);
		camera.lookAt(0, 0, 0);

		let renderer;
		try {
			renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		} catch {
			noWebGL = true;
			onnowebgl();
			return;
		}
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setSize(W, H);
		host.appendChild(renderer.domElement);

		scene.add(new THREE.AmbientLight(0xffffff, 1.0));
		const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
		keyLight.position.set(2, 5, 9);
		scene.add(keyLight);
		const rimL = new THREE.DirectionalLight(0xc084fc, 1.2);
		rimL.position.set(-7, 2, 4);
		scene.add(rimL);
		const rimR = new THREE.DirectionalLight(0x22d3ee, 1.1);
		rimR.position.set(7, -2, 4);
		scene.add(rimR);

		const machine = new THREE.Group();
		scene.add(machine);

		const totalW = REELS.length * REEL_W + (REELS.length - 1) * GAP;
		const disposables = [];
		const track = (o) => (disposables.push(o), o);

		// Gold that actually reads as gold. Pure metal with no environment map
		// renders near-black, so these stay part-metal and lean on the lights.
		const goldMat = track(
			new THREE.MeshStandardMaterial({ color: 0xf0b429, metalness: 0.55, roughness: 0.28 })
		);
		const chromeMat = track(
			new THREE.MeshStandardMaterial({ color: 0xb9c3d0, metalness: 0.5, roughness: 0.3 })
		);
		const shellMat = track(
			new THREE.MeshStandardMaterial({ color: 0x1b1533, metalness: 0.35, roughness: 0.55 })
		);

		// The window shows three stops; everything outside it is masked off.
		const WINDOW_HALF = CELL_H * 1.5;
		const CAB_HALF = RADIUS + 0.65;
		const FRONT_Z = RADIUS + 0.32;

		// ── Cabinet behind the reels ───────────────────────────────
		const cabinet = new THREE.Mesh(
			track(new THREE.BoxGeometry(totalW + 1.7, CAB_HALF * 2, 1.2)),
			track(new THREE.MeshStandardMaterial({ color: 0x261d40, metalness: 0.4, roughness: 0.5 }))
		);
		cabinet.position.z = -RADIUS - 0.7;
		machine.add(cabinet);

		// Top and bottom masks, IN FRONT of the reels, hiding the stops that are
		// curving away. Without these the drum reads as a wheel, not a window.
		const maskH = CAB_HALF - WINDOW_HALF;
		for (const s of [-1, 1]) {
			const mask = new THREE.Mesh(
				track(new THREE.BoxGeometry(totalW + 1.7, maskH, 0.7)),
				shellMat
			);
			mask.position.set(0, s * (WINDOW_HALF + maskH / 2), FRONT_Z - 0.05);
			machine.add(mask);

			const trim = new THREE.Mesh(track(new THREE.BoxGeometry(totalW + 1.7, 0.11, 0.16)), goldMat);
			trim.position.set(0, s * WINDOW_HALF, FRONT_Z + 0.3);
			machine.add(trim);
		}

		// Gold posts between and beside the reels.
		for (let i = 0; i <= REELS.length; i++) {
			const post = new THREE.Mesh(
				track(new THREE.BoxGeometry(0.16, WINDOW_HALF * 2 + 0.2, 0.16)),
				goldMat
			);
			post.position.set(-totalW / 2 - GAP / 2 + i * (REEL_W + GAP), 0, FRONT_Z + 0.28);
			machine.add(post);
		}

		// Payline marker down the middle row.
		for (const s of [-1, 1]) {
			const pip = new THREE.Mesh(
				track(new THREE.ConeGeometry(0.14, 0.3, 3)),
				track(new THREE.MeshStandardMaterial({ color: 0xf43f5e, metalness: 0.3, roughness: 0.4 }))
			);
			pip.rotation.z = s * -Math.PI / 2;
			pip.position.set(s * (totalW / 2 + 0.42), 0, FRONT_Z + 0.3);
			machine.add(pip);
		}

		// ── Reels ──────────────────────────────────────────────────
		const reels = REELS.map((strip, i) => {
			const drum = new THREE.Group();
			drum.position.x = -totalW / 2 + REEL_W / 2 + i * (REEL_W + GAP);

			const geo = track(new THREE.PlaneGeometry(REEL_W, CELL_H * 1.02));
			strip.forEach((id, stop) => {
				const theta = stop * ANGLE_PER_STOP;
				const panel = new THREE.Mesh(
					geo,
					track(
						new THREE.MeshStandardMaterial({
							map: track(faceTexture(id)),
							metalness: 0.1,
							roughness: 0.7,
							side: THREE.FrontSide
						})
					)
				);
				panel.position.set(0, RADIUS * Math.cos(theta), RADIUS * Math.sin(theta));
				panel.rotation.x = theta - Math.PI / 2;
				drum.add(panel);
			});

			// Chrome hubs on each side.
			for (const s of [-1, 1]) {
				const hub = new THREE.Mesh(
					track(new THREE.TorusGeometry(RADIUS + 0.04, 0.07, 10, 56)),
					chromeMat
				);
				hub.rotation.y = Math.PI / 2;
				hub.position.x = (s * REEL_W) / 2 + s * 0.04;
				drum.add(hub);
			}

			machine.add(drum);
			return { drum, angle: angleForStop(0), velocity: 0, target: null, stopAt: 0, settled: true };
		});
		for (const r of reels) r.drum.rotation.x = r.angle;

		// ── Spin ───────────────────────────────────────────────────
		const SPIN_SPEED = 22; // rad/s while free-running
		let pending = null;
		let landedFired = false;

		api.spinTo = (stops) => {
			pending = stops;
			landedFired = false;
			const now = performance.now() / 1000;
			reels.forEach((r, i) => {
				r.settled = false;
				r.target = null;
				r.velocity = SPIN_SPEED + i * 1.5;
				r.stopAt = now + 1.1 + i * 0.42; // land left to right
			});
		};

		/** Land on the stop after at least one more full turn, never backwards. */
		function lockTarget(r, stop) {
			const want = angleForStop(stop);
			const turns = Math.ceil((r.angle - want) / (Math.PI * 2)) + 1;
			r.target = want + turns * Math.PI * 2;
		}

		const clock = new THREE.Clock();
		let raf = 0;
		let disposed = false;

		function tick() {
			if (disposed) return;
			raf = requestAnimationFrame(tick);
			const dt = Math.min(clock.getDelta(), 0.05);
			const now = performance.now() / 1000;

			let allSettled = true;
			reels.forEach((r, i) => {
				if (r.settled) return;
				allSettled = false;
				if (r.target === null) {
					r.angle -= r.velocity * dt;
					if (now >= r.stopAt && pending) lockTarget(r, pending[i]);
				} else {
					// Ease in, clamped so it never runs faster than the free spin.
					const remaining = r.target - r.angle;
					r.angle += Math.max(remaining * Math.min(1, dt * 6.5), -r.velocity * dt);
					if (Math.abs(r.target - r.angle) < 0.003) {
						r.angle = r.target;
						r.settled = true;
					}
				}
				r.drum.rotation.x = r.angle;
			});

			if (allSettled && pending && !landedFired) {
				landedFired = true;
				pending = null;
				onlanded();
			}

			machine.rotation.y = Math.sin(now * 0.5) * 0.05;
			machine.rotation.x = Math.sin(now * 0.36) * 0.022;
			renderer.render(scene, camera);
		}
		tick();

		/**
		 * Pull the camera back just far enough that the whole cabinet fits, on
		 * whatever aspect ratio the device has. A fixed distance clips the outer
		 * reels on narrow screens and strands the machine in space on wide ones.
		 */
		function fitCamera() {
			const half = Math.tan((camera.fov * Math.PI) / 180 / 2);
			const needH = CAB_HALF + 0.25;
			const needW = totalW / 2 + 1.1;
			camera.position.z = Math.max(needH / half, needW / (half * camera.aspect));
		}

		function onResize() {
			const w = host?.clientWidth;
			const h = host?.clientHeight;
			if (!w || !h) return;
			camera.aspect = w / h;
			fitCamera();
			camera.updateProjectionMatrix();
			renderer.setSize(w, h);
		}
		fitCamera();
		camera.updateProjectionMatrix();
		window.addEventListener('resize', onResize);

		return () => {
			disposed = true;
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onResize);
			for (const d of disposables) d.dispose?.();
			renderer.dispose();
			renderer.domElement.remove();
		};
	});
</script>

<div bind:this={host} class="w-full h-full">
	{#if noWebGL}
		<div class="w-full h-full grid place-items-center text-sm text-base-content/50 px-6 text-center">
			3D is unavailable on this device — the reels below still spin.
		</div>
	{/if}
</div>
