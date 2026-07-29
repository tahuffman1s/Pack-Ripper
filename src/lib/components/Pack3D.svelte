<script>
	import { onMount } from 'svelte';
	import * as THREE from 'three';

	let {
		setName = 'Booster',
		packName = 'Draft Booster',
		setCode = '',
		cardCount = 15,
		art = null, // pack photo (product) or key-card art, as a data URL
		productPhoto = false, // true when `art` is the real TCGplayer pack photo
		color = '#c084fc',
		onripped = () => {}
	} = $props();

	let host = $state();
	let hint = $state(true);
	let flash = $state(false);
	let noWebGL = $state(false);

	// A real booster is 70 × 133 mm of metallised film, heat-crimped at both
	// ends. Every number below is that pack, normalised to its height.
	const ASPECT = 0.526; // width / height — measured off real pack photos
	const CRIMP = 0.062; // flat corrugated seal at top and bottom
	const SHOULDER = 0.055; // fold where the flat crimp meets the bulge
	const SEAM_V = 0.078; // tear line, just below the top crimp
	const RIDGES = 64; // corrugation ridges across a crimp band

	onMount(() => {
		const W = host.clientWidth;
		const H = host.clientHeight;

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(36, W / H, 0.1, 100);
		camera.position.set(0, 0, 9.1);

		let renderer;
		try {
			renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		} catch (e) {
			// device without WebGL — fall back to a 2D pack + working rip button
			noWebGL = true;
			host.__rip = () => {
				flash = true;
				setTimeout(() => {
					flash = false;
					onripped();
				}, 500);
			};
			return;
		}
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setSize(W, H);
		renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.04;
		host.appendChild(renderer.domElement);

		const LOW = window.matchMedia?.('(max-width: 640px)')?.matches ?? false;

		const base = new THREE.Color(color);
		const dark = base.clone().multiplyScalar(0.26);
		const hex = (c) => '#' + c.getHexString();

		scene.add(new THREE.AmbientLight(0xffffff, 0.45));
		const key = new THREE.DirectionalLight(0xffffff, 1.45);
		key.position.set(2.6, 3.6, 5.4);
		scene.add(key);
		const fill = new THREE.DirectionalLight(0xdce6ff, 0.38);
		fill.position.set(-3.2, 1.2, 4);
		scene.add(fill);
		const rim = new THREE.DirectionalLight(base.clone(), 1.1);
		rim.position.set(-4, -2.4, 2.2);
		scene.add(rim);

		// ── Holographic environment ───────────────────────────────
		// Foil doesn't just shine, it throws back colour. A hard specular bar
		// plus spectral bands means turning the pack sweeps a rainbow streak
		// across it, which is what actually reads as "foil".
		{
			const ec = document.createElement('canvas');
			ec.width = 1024;
			ec.height = 512;
			const ex = ec.getContext('2d');
			const bg = ex.createLinearGradient(0, 0, 0, 512);
			bg.addColorStop(0, '#191631');
			bg.addColorStop(0.42, '#05060c');
			bg.addColorStop(0.62, '#080a12');
			bg.addColorStop(1, '#0d1322');
			ex.fillStyle = bg;
			ex.fillRect(0, 0, 1024, 512);

			ex.globalCompositeOperation = 'lighter';
			for (let i = 0; i < 8; i++) {
				const y = 132 + i * 26;
				const hue = (i * 44 + 200) % 360;
				const gr = ex.createLinearGradient(0, y - 24, 0, y + 24);
				gr.addColorStop(0, `hsla(${hue},80%,55%,0)`);
				gr.addColorStop(0.5, `hsla(${hue},80%,55%,0.19)`);
				gr.addColorStop(1, `hsla(${hue},80%,55%,0)`);
				ex.fillStyle = gr;
				ex.fillRect(0, y - 24, 1024, 48);
			}
			// the specular bar and two soft columns that travel as it turns
			const bar = ex.createLinearGradient(0, 232, 0, 296);
			bar.addColorStop(0, 'rgba(255,255,255,0)');
			bar.addColorStop(0.5, 'rgba(255,255,255,0.62)');
			bar.addColorStop(1, 'rgba(255,255,255,0)');
			ex.fillStyle = bar;
			ex.fillRect(0, 232, 1024, 64);
			for (const [cxp, wd, a] of [
				[210, 120, 0.5],
				[690, 180, 0.34]
			]) {
				const col = ex.createLinearGradient(cxp - wd, 0, cxp + wd, 0);
				col.addColorStop(0, 'rgba(190,210,255,0)');
				col.addColorStop(0.5, `rgba(215,230,255,${a})`);
				col.addColorStop(1, 'rgba(190,210,255,0)');
				ex.fillStyle = col;
				ex.fillRect(cxp - wd, 0, wd * 2, 512);
			}
			ex.globalCompositeOperation = 'source-over';

			const envTex = new THREE.CanvasTexture(ec);
			envTex.mapping = THREE.EquirectangularReflectionMapping;
			const pmrem = new THREE.PMREMGenerator(renderer);
			scene.environment = pmrem.fromEquirectangular(envTex).texture;
			envTex.dispose();
			pmrem.dispose();
		}

		// ── Wrapper artwork canvas (front) ────────────────────────
		const CW = 560;
		const CH = Math.round(CW / ASPECT); // 1065 — same shape as the pack
		const full = document.createElement('canvas');
		full.width = CW;
		full.height = CH;
		const g = full.getContext('2d');

		const backC = document.createElement('canvas');
		backC.width = CW;
		backC.height = CH;
		const bg2 = backC.getContext('2d');

		let accent = base.clone(); // refined from the photo once art arrives
		const py = (f) => f * CH;
		const SAFE = CW * 0.055; // print margin, matching a real wrapper's

		/** Corrugated, doubled-over film: flat, darker, and finely ridged. */
		function paintCrimp(top) {
			const y0 = top ? 0 : CH - py(CRIMP);
			const h = py(CRIMP);
			const c1 = hex(accent.clone().multiplyScalar(0.3));
			const c2 = hex(accent.clone().multiplyScalar(0.13));

			const bandG = g.createLinearGradient(0, y0, 0, y0 + h);
			bandG.addColorStop(0, top ? c2 : c1);
			bandG.addColorStop(0.5, hex(accent.clone().multiplyScalar(0.22)));
			bandG.addColorStop(1, top ? c1 : c2);
			g.fillStyle = bandG;
			g.fillRect(0, y0, CW, h);

			// ridges — the crimping jaws leave a fine vertical comb
			const pitch = CW / RIDGES;
			for (let i = 0; i < RIDGES; i++) {
				const x = i * pitch;
				const rg = g.createLinearGradient(x, 0, x + pitch, 0);
				rg.addColorStop(0, 'rgba(0,0,0,0.42)');
				rg.addColorStop(0.42, 'rgba(255,255,255,0.16)');
				rg.addColorStop(0.6, 'rgba(255,255,255,0.05)');
				rg.addColorStop(1, 'rgba(0,0,0,0.42)');
				g.fillStyle = rg;
				g.fillRect(x, y0 + h * (top ? 0.1 : 0.06), pitch, h * 0.84);
			}

			// the fold: a bright crease then shadow as the film leaves the crimp
			const fy = top ? y0 + h : y0;
			const foldG = g.createLinearGradient(0, fy - (top ? 0 : py(0.03)), 0, fy + (top ? py(0.03) : 0));
			foldG.addColorStop(top ? 0 : 1, 'rgba(255,255,255,0.3)');
			foldG.addColorStop(top ? 1 : 0, 'rgba(0,0,0,0)');
			g.fillStyle = foldG;
			g.fillRect(0, top ? fy : fy - py(0.03), CW, py(0.03));
			g.fillStyle = 'rgba(0,0,0,0.5)';
			g.fillRect(0, top ? fy - 2 : fy, CW, 2);
		}

		/**
		 * Fit a photo's trimmed bounds over the wrapper, inside gutters the width
		 * of the rolled edge. The photo then lands exactly on the flat face — its
		 * own margins survive instead of curving away — and the gutters are filled
		 * by extending its edge columns, giving the roll a clean colour to carry.
		 */
		function drawFitted(ctx, img, b) {
			const gut = Math.max(1, Math.round(CW * PRINT_INSET));
			const iw = CW - gut * 2;
			const a = b.w / b.h;
			if (Math.abs(a / (iw / CH) - 1) < 0.2) {
				// close enough to a real pack — stretch so its printed crimps
				// land exactly on the geometry's crimps
				ctx.drawImage(img, b.x, b.y, b.w, b.h, gut, 0, iw, CH);
			} else {
				// odd crop: cover-fit, anchored high so the artwork survives
				let dw = iw,
					dh = iw / a;
				if (dh < CH) {
					dh = CH;
					dw = CH * a;
				}
				ctx.save();
				ctx.beginPath();
				ctx.rect(gut, 0, iw, CH);
				ctx.clip();
				ctx.drawImage(img, b.x, b.y, b.w, b.h, gut + (iw - dw) / 2, Math.min(0, (CH - dh) * 0.35), dw, dh);
				ctx.restore();
			}
			ctx.drawImage(ctx.canvas, gut, 0, 1, CH, 0, 0, gut, CH);
			ctx.drawImage(ctx.canvas, CW - gut - 1, 0, 1, CH, CW - gut, 0, gut, CH);
		}

		function paintWrapper(artImg, isProduct) {
			g.setTransform(1, 0, 0, 1, 0, 0);
			g.globalAlpha = 1;
			g.globalCompositeOperation = 'source-over';
			g.imageSmoothingEnabled = true;

			// A real pack photo already *is* a wrapper — logo, art, crimps and
			// all. Trim the studio background off and let it fill the pack.
			if (isProduct && artImg) {
				const b = trimBox(artImg);
				g.fillStyle = '#0a0d16';
				g.fillRect(0, 0, CW, CH);
				drawFitted(g, artImg, b);
				const s = sampleAccent(artImg, b);
				if (s) accent = s;
				paintBack();
				return;
			}

			if (artImg) {
				// full-bleed foil field: a heavily blurred copy of the art
				const sm = document.createElement('canvas');
				sm.width = 22;
				sm.height = Math.max(2, Math.round(22 / ASPECT));
				const sg = sm.getContext('2d');
				const iar = artImg.width / artImg.height;
				let sw = sm.width,
					sh = sm.width / iar;
				if (sh < sm.height) {
					sh = sm.height;
					sw = sm.height * iar;
				}
				sg.drawImage(artImg, (sm.width - sw) / 2, (sm.height - sh) / 2, sw, sh);
				g.drawImage(sm, -4, -4, CW + 8, CH + 8);

				// the art itself, laid in sharp and feathered into that field
				const aw = CW * 1.06;
				const ah = aw / iar;
				const ax = (CW - aw) / 2;
				const ay = py(0.46) - ah * 0.52;
				const layer = document.createElement('canvas');
				layer.width = CW;
				layer.height = CH;
				const lg = layer.getContext('2d');
				lg.drawImage(artImg, ax, ay, aw, ah);
				const fade = lg.createLinearGradient(0, ay, 0, ay + ah);
				fade.addColorStop(0, 'rgba(0,0,0,0)');
				fade.addColorStop(0.15, 'rgba(0,0,0,1)');
				fade.addColorStop(0.82, 'rgba(0,0,0,1)');
				fade.addColorStop(1, 'rgba(0,0,0,0)');
				lg.globalCompositeOperation = 'destination-in';
				lg.fillStyle = fade;
				lg.fillRect(0, ay, CW, ah);
				g.drawImage(layer, 0, 0);
			} else {
				const grad = g.createLinearGradient(0, 0, CW, CH);
				grad.addColorStop(0, hex(base.clone().multiplyScalar(0.95)));
				grad.addColorStop(0.55, hex(dark));
				grad.addColorStop(1, '#0a0d16');
				g.fillStyle = grad;
				g.fillRect(0, 0, CW, CH);
				g.globalAlpha = 0.12;
				for (let i = -8; i < 22; i++) {
					g.strokeStyle = i % 2 ? '#ffffff' : hex(base);
					g.lineWidth = 16;
					g.beginPath();
					g.moveTo(i * 52, 0);
					g.lineTo(i * 52 - 300, CH);
					g.stroke();
				}
				g.globalAlpha = 1;
			}

			// vignette + darkened plate area, so the type stays readable
			const vig = g.createRadialGradient(CW / 2, py(0.42), CW * 0.28, CW / 2, py(0.5), CW * 1.05);
			vig.addColorStop(0, 'rgba(0,0,0,0)');
			vig.addColorStop(1, 'rgba(0,0,0,0.55)');
			g.fillStyle = vig;
			g.fillRect(0, 0, CW, CH);
			const plate = g.createLinearGradient(0, py(0.6), 0, CH);
			plate.addColorStop(0, 'rgba(0,0,0,0)');
			plate.addColorStop(0.45, hex(dark) + 'aa');
			plate.addColorStop(1, hex(dark) + 'ee');
			g.fillStyle = plate;
			g.fillRect(0, py(0.6), CW, CH - py(0.6));
			const topSh = g.createLinearGradient(0, py(CRIMP), 0, py(0.3));
			topSh.addColorStop(0, 'rgba(4,6,12,0.8)');
			topSh.addColorStop(1, 'rgba(4,6,12,0)');
			g.fillStyle = topSh;
			g.fillRect(0, py(CRIMP), CW, py(0.24));

			// ── printed furniture, laid out like a real booster ──
			g.textAlign = 'left';
			g.textBaseline = 'alphabetic';
			g.fillStyle = 'rgba(255,255,255,0.94)';
			g.font = `700 ${Math.round(py(0.0235))}px system-ui, sans-serif`;
			g.letterSpacing = '1.5px';
			// keep type inside SAFE — the outer strip of the texture wraps around
			// the rolled side edge and is never seen face-on
			g.fillText(`${cardCount} CARDS`, SAFE, py(0.128));
			g.letterSpacing = '0px';

			// age badge, top-right
			const br = py(0.026);
			g.beginPath();
			g.arc(CW - SAFE - br * 1.35, py(0.12), br, 0, Math.PI * 2);
			g.fillStyle = 'rgba(255,255,255,0.92)';
			g.fill();
			g.fillStyle = '#12182a';
			g.textAlign = 'center';
			g.font = `800 ${Math.round(br * 0.95)}px system-ui, sans-serif`;
			g.fillText('13+', CW - SAFE - br * 1.35, py(0.12) + br * 0.34);

			// brand wordmark
			g.textAlign = 'center';
			g.shadowColor = 'rgba(0,0,0,0.75)';
			g.shadowBlur = py(0.014);
			g.fillStyle = '#ffffff';
			g.font = `900 ${Math.round(py(0.043))}px system-ui, sans-serif`;
			g.letterSpacing = '3px';
			g.fillText('⚡ PACKRIPPER', CW / 2, py(0.192));
			g.font = `700 ${Math.round(py(0.019))}px system-ui, sans-serif`;
			g.letterSpacing = '6px';
			g.fillStyle = 'rgba(255,255,255,0.8)';
			g.fillText('TRADING CARD SIMULATOR', CW / 2, py(0.222));
			g.letterSpacing = '0px';
			g.shadowBlur = 0;

			// set name — big serif display type, gold-leafed like the real thing.
			// Shrink until it fits two lines rather than crowd the ribbon.
			const nameMax = CW - SAFE * 2;
			let nameSize = 0;
			for (const f of [0.062, 0.056, 0.05, 0.044, 0.038, 0.033]) {
				nameSize = Math.round(py(f));
				g.font = `700 ${nameSize}px Georgia, "Times New Roman", serif`;
				if (measureLines(g, setName.toUpperCase(), nameMax).length <= 2) break;
			}
			g.font = `700 ${nameSize}px Georgia, "Times New Roman", serif`;
			const leaf = g.createLinearGradient(0, py(0.66), 0, py(0.78));
			leaf.addColorStop(0, '#fffaf0');
			leaf.addColorStop(0.45, '#f3dfa8');
			leaf.addColorStop(0.55, '#d9b866');
			leaf.addColorStop(1, '#fff4dc');
			g.lineJoin = 'round';
			g.strokeStyle = 'rgba(6,8,16,0.85)';
			g.lineWidth = nameSize * 0.14;
			g.shadowColor = 'rgba(0,0,0,0.6)';
			g.shadowBlur = py(0.01);
			wrapText(g, setName.toUpperCase(), CW / 2, py(0.715), nameMax, nameSize * 1.06, leaf);
			g.shadowBlur = 0;

			// pack-type ribbon
			const ry = py(0.822);
			const rh = py(0.05);
			const rib = g.createLinearGradient(0, ry, 0, ry + rh);
			rib.addColorStop(0, '#f7f9ff');
			rib.addColorStop(0.5, '#e3e9f6');
			rib.addColorStop(1, '#b9c4d8');
			g.fillStyle = rib;
			g.fillRect(0, ry, CW, rh);
			g.fillStyle = hex(accent.clone().multiplyScalar(1.35));
			g.fillRect(0, ry, CW, Math.max(1, py(0.0035)));
			g.fillRect(0, ry + rh - Math.max(1, py(0.0035)), CW, Math.max(1, py(0.0035)));
			g.fillStyle = '#141a2c';
			g.font = `800 ${Math.round(rh * 0.5)}px system-ui, sans-serif`;
			g.letterSpacing = '2px';
			g.fillText(packName.toUpperCase(), CW / 2, ry + rh * 0.67);
			g.letterSpacing = '0px';

			// footer line
			g.fillStyle = 'rgba(255,255,255,0.62)';
			g.font = `600 ${Math.round(py(0.0175))}px system-ui, sans-serif`;
			g.letterSpacing = '2px';
			g.fillText(
				setCode ? `${setCode.toUpperCase()}  ·  SIMULATED PRODUCT` : 'SIMULATED PRODUCT',
				CW / 2,
				py(0.905)
			);
			g.letterSpacing = '0px';

			paintCrimp(true);
			paintCrimp(false);
			paintBack();
		}

		/** Reverse of the wrapper: lap seam, legal block, barcode. */
		function paintBack() {
			const b = bg2;
			b.setTransform(1, 0, 0, 1, 0, 0);
			b.globalAlpha = 1;
			b.textBaseline = 'alphabetic';
			const d1 = hex(accent.clone().multiplyScalar(0.34));
			const d2 = hex(accent.clone().multiplyScalar(0.14));
			const grad = b.createLinearGradient(0, 0, CW, CH);
			grad.addColorStop(0, d1);
			grad.addColorStop(0.5, d2);
			grad.addColorStop(1, d1);
			b.fillStyle = grad;
			b.fillRect(0, 0, CW, CH);

			// tiled watermark
			b.save();
			b.globalAlpha = 0.07;
			b.fillStyle = '#ffffff';
			b.font = `900 ${Math.round(py(0.02))}px system-ui, sans-serif`;
			b.textAlign = 'center';
			for (let yy = py(0.1); yy < CH - py(0.1); yy += py(0.05))
				for (let xx = 0; xx < CW + 120; xx += 150)
					b.fillText('PACKRIPPER', xx + ((yy / py(0.05)) % 2) * 75, yy);
			b.restore();

			// the lap seam — where the film is folded and welded down the back
			const sx = CW * 0.5;
			const sw = CW * 0.17;
			const seam = b.createLinearGradient(sx - sw / 2, 0, sx + sw / 2, 0);
			seam.addColorStop(0, 'rgba(0,0,0,0.5)');
			seam.addColorStop(0.12, 'rgba(255,255,255,0.16)');
			seam.addColorStop(0.5, 'rgba(255,255,255,0.05)');
			seam.addColorStop(0.88, 'rgba(255,255,255,0.14)');
			seam.addColorStop(1, 'rgba(0,0,0,0.5)');
			b.fillStyle = seam;
			b.fillRect(sx - sw / 2, 0, sw, CH);

			// legal block + barcode
			b.textAlign = 'center';
			b.fillStyle = 'rgba(255,255,255,0.5)';
			b.font = `600 ${Math.round(py(0.013))}px system-ui, sans-serif`;
			b.fillText('SIMULATED PRODUCT · NO CARDS INSIDE', CW / 2, py(0.735));
			b.fillText(`${packName.toUpperCase()} · ${cardCount} CARDS`, CW / 2, py(0.757));
			b.fillStyle = '#f2f4f8';
			const bw = CW * 0.4;
			const bh = py(0.05);
			const bx = (CW - bw) / 2;
			const by = py(0.79);
			b.fillRect(bx - 6, by - 5, bw + 12, bh + 10);
			b.fillStyle = '#0a0d16';
			let px2 = bx;
			let seed = 9;
			while (px2 < bx + bw - 2) {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				const w = 1 + (seed >> 16) % 4;
				b.fillRect(px2, by, w, bh);
				px2 += w + 1 + ((seed >> 8) % 3);
			}
			b.fillStyle = 'rgba(255,255,255,0.42)';
			b.font = `600 ${Math.round(py(0.014))}px ui-monospace, monospace`;
			b.fillText((setCode || 'PACKRIP').toUpperCase(), CW / 2, py(0.862));

			// same crimps on the reverse
			const bAccent = accent;
			for (const top of [true, false]) {
				const y0 = top ? 0 : CH - py(CRIMP);
				const h = py(CRIMP);
				b.fillStyle = hex(bAccent.clone().multiplyScalar(0.24));
				b.fillRect(0, y0, CW, h);
				const pitch = CW / RIDGES;
				for (let i = 0; i < RIDGES; i++) {
					const x = i * pitch;
					const rg = b.createLinearGradient(x, 0, x + pitch, 0);
					rg.addColorStop(0, 'rgba(0,0,0,0.45)');
					rg.addColorStop(0.42, 'rgba(255,255,255,0.14)');
					rg.addColorStop(1, 'rgba(0,0,0,0.45)');
					b.fillStyle = rg;
					b.fillRect(x, y0 + h * 0.08, pitch, h * 0.84);
				}
				b.fillStyle = 'rgba(0,0,0,0.45)';
				b.fillRect(0, top ? y0 + h - 2 : y0, CW, 2);
			}
			backTex.needsUpdate = true;
		}

		const frontTex = new THREE.CanvasTexture(full);
		const backTex = new THREE.CanvasTexture(backC);
		for (const t of [frontTex, backTex]) {
			t.colorSpace = THREE.SRGBColorSpace;
			t.anisotropy = renderer.capabilities.getMaxAnisotropy();
		}

		// ── Foil surface maps ─────────────────────────────────────
		// Crinkle, creases and the crimp comb, as a height field turned into a
		// normal map — this is what makes the light break up like real film.
		const MW = LOW ? 384 : 512;
		const MH = Math.round(MW / ASPECT);
		const { normal: normalTex, orm: ormTex } = foilMaps(MW, MH, CRIMP, SHOULDER, RIDGES);
		normalTex.anisotropy = ormTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

		const filmMat = (map) => {
			const m = new THREE.MeshPhysicalMaterial({
				map,
				normalMap: normalTex,
				normalScale: new THREE.Vector2(0.3, 0.3),
				roughnessMap: ormTex,
				metalnessMap: ormTex,
				roughness: 1,
				metalness: 1,
				clearcoat: 0.5,
				clearcoatRoughness: 0.3,
				envMapIntensity: 1.15
			});
			if (!LOW) {
				m.iridescence = 0.2;
				m.iridescenceIOR = 1.35;
				m.iridescenceThicknessRange = [160, 420];
				m.anisotropy = 0.4;
				m.anisotropyRotation = Math.PI / 2; // sheen streaks across the pack
			}
			return m;
		};

		// ── Geometry ──────────────────────────────────────────────
		const PH = 4.42;
		const PW = PH * ASPECT;
		const A0 = PW / 2; // half-width at the crimp — the pack's widest point
		const RMAX = 0.1175; // half-thickness over the card stack
		const TCRIMP = 0.01; // half-thickness of the doubled, crimped film
		const seamY = PH / 2 - SEAM_V * PH;

		/** Half-thickness down the pack: flat crimps, a fold, then the stack. */
		function halfThick(v) {
			const d = Math.min(v, 1 - v);
			if (d <= CRIMP) return TCRIMP;
			const k = Math.min(1, (d - CRIMP) / SHOULDER);
			return TCRIMP + (RMAX - TCRIMP) * (k * k * (3 - 2 * k));
		}

		/**
		 * Cross-section of a sealed film tube: a plateau over the cards, capped
		 * by rolled edges. Half-perimeter is fixed, so the pack is widest where
		 * it's crimped flat and narrows where the cards push it out — which is
		 * exactly the stepped silhouette a real booster has.
		 */
		function section(u, r) {
			const a = A0 - 0.57 * r;
			// the roll's projected width is its radius, nothing more
			const edge = Math.min(0.3, r / a);
			const q = Math.abs(2 * u - 1);
			let z = r;
			if (edge > 0 && q > 1 - edge) {
				// Cosine roll, not a circular one: a circle's tangent goes vertical
				// at the fold, and that grazing band mirrors the environment into a
				// blown-out white stripe down each side of the pack.
				const t = Math.min(1, (q - (1 - edge)) / edge);
				z = r * Math.cos(t * Math.PI * 0.5);
			}
			return { x: (2 * u - 1) * a, z, edge };
		}

		/**
		 * Put the whole printed design on the flat face — a linear wrap swallows
		 * the wrapper's own margins (a pack photo's "15 CARDS" and its like).
		 *
		 * The roll holds the colour a hair inside the design rather than sampling
		 * the outermost column: a studio photo's extreme edge is part backdrop and
		 * part blown-out highlight, and smearing that across the roll paints a
		 * white stripe down each side. Curvature shading gives the roll its falloff.
		 */
		const PRINT_INSET = 0.016;
		function printU(u, edge) {
			const s = 2 * u - 1;
			const flat = 1 - edge;
			const k = PRINT_INSET;
			if (Math.abs(s) <= flat) return 0.5 + (s / flat) * (0.5 - k);
			return s > 0 ? 1 - k : k;
		}

		/** Ragged tear, shared by the strip and the body so the two interlock. */
		const tearJag = (u) =>
			(Math.sin(u * 41.3 + 0.7) * 0.5 + Math.sin(u * 97.7) * 0.3 + Math.sin(u * 173.1) * 0.2) * 0.011;

		/**
		 * One face of the wrapper over v ∈ [v0,v1]. `side` +1 front, -1 back;
		 * the back is mirrored in x so its winding (and its print) face outward.
		 */
		function face(v0, v1, segX, segY, side) {
			const geo = new THREE.PlaneGeometry(1, 1, segX, segY);
			const pos = geo.attributes.position;
			const uv = geo.attributes.uv;
			for (let i = 0; i < pos.count; i++) {
				const u = uv.getX(i);
				let v = v0 + (1 - uv.getY(i)) * (v1 - v0);
				// jag the rows nearest the seam, keyed off world x so the front
				// and back tears meet at the silhouette
				const near = 1 - Math.min(1, Math.abs(v - SEAM_V) / 0.022);
				if (near > 0) v += tearJag(side > 0 ? u : 1 - u) * near;

				const r = halfThick(v);
				const s = section(u, r);
				const bulge = (r - TCRIMP) / (RMAX - TCRIMP);
				// slack film wrinkles over the cards; the crimp gets its comb
				let z =
					s.z + bulge * (Math.sin(u * 19 + v * 8) * Math.sin(v * 25) * 0.0035 + Math.sin(u * 7 - v * 31) * 0.002);
				const d = Math.min(v, 1 - v);
				if (d <= CRIMP + 0.012) {
					const t = Math.min(1, (CRIMP + 0.012 - d) / 0.02);
					z += Math.cos(u * RIDGES * Math.PI * 2) * 0.0045 * t;
				}
				let y = PH / 2 - v * PH;
				// scalloped outer edge, same pitch as the comb
				if (d < 0.006) {
					const t = 1 - d / 0.006;
					const w = (0.5 + 0.5 * Math.cos(u * RIDGES * Math.PI * 2)) * 0.008 * t;
					y += v < 0.5 ? -w : w;
				}
				pos.setXYZ(i, s.x * side, y, z * side);
				uv.setXY(i, printU(u, s.edge), 1 - v);
			}
			pos.needsUpdate = true;
			uv.needsUpdate = true;
			geo.computeVertexNormals();
			try {
				geo.computeTangents();
			} catch {
				/* anisotropy falls back to screen-space derivatives */
			}
			return geo;
		}

		const pack = new THREE.Group();
		scene.add(pack);

		const SX = LOW ? 48 : 72;
		const SY = LOW ? 72 : 108;

		// BODY — everything below the tear line
		const body = new THREE.Group();
		pack.add(body);
		const bodyFrontMat = filmMat(frontTex);
		const bodyBackMat = filmMat(backTex);
		const bodyFront = new THREE.Mesh(face(SEAM_V, 1, SX, SY, 1), bodyFrontMat);
		const bodyBack = new THREE.Mesh(face(SEAM_V, 1, SX, Math.round(SY * 0.6), -1), bodyBackMat);
		body.add(bodyFront, bodyBack);

		// what's inside: the wrapper's dark interior and the card stack's edges
		const insideTex = stackTexture();
		const insideMat = new THREE.MeshStandardMaterial({ color: 0x05070c, roughness: 0.85, metalness: 0.1 });
		const inside = new THREE.Mesh(new THREE.PlaneGeometry(PW * 0.9, PH * 0.14), insideMat);
		inside.position.set(0, seamY - PH * 0.062, 0);
		body.add(inside);
		const stackMat = new THREE.MeshStandardMaterial({ map: insideTex, roughness: 0.6, metalness: 0.05 });
		const stack = new THREE.Mesh(new THREE.PlaneGeometry(PW * 0.8, PH * 0.1), stackMat);
		stack.position.set(0, seamY - PH * 0.05, RMAX * 0.35);
		body.add(stack);

		// STRIP — the crimped top, hinged on the seam so it tears off
		const stripPivot = new THREE.Group();
		stripPivot.position.y = seamY;
		pack.add(stripPivot);
		const stripFrontMat = filmMat(frontTex);
		const stripBackMat = filmMat(backTex);
		const sf = face(0, SEAM_V, SX, 14, 1);
		const sb = face(0, SEAM_V, SX, 10, -1);
		sf.translate(0, -seamY, 0);
		sb.translate(0, -seamY, 0);
		stripPivot.add(new THREE.Mesh(sf, stripFrontMat), new THREE.Mesh(sb, stripBackMat));

		// ── Burst light + particles from the opening ───────────────
		const burstTex = radialTexture(color);
		const burst = new THREE.Sprite(
			new THREE.SpriteMaterial({
				map: burstTex,
				color: 0xffffff,
				transparent: true,
				opacity: 0,
				blending: THREE.AdditiveBlending,
				depthWrite: false
			})
		);
		burst.scale.set(0.1, 0.1, 0.1);
		burst.position.set(0, seamY, RMAX * 2);
		pack.add(burst);

		const PN = 46;
		const pgeo = new THREE.BufferGeometry();
		const ppos = new Float32Array(PN * 3);
		const pvel = [];
		for (let i = 0; i < PN; i++) {
			ppos[i * 3] = (Math.random() - 0.5) * PW * 0.7;
			ppos[i * 3 + 1] = seamY;
			ppos[i * 3 + 2] = RMAX;
			pvel.push([(Math.random() - 0.5) * 0.06, 0.04 + Math.random() * 0.08, (Math.random() - 0.2) * 0.05]);
		}
		pgeo.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
		const pmat = new THREE.PointsMaterial({
			color: new THREE.Color(color),
			size: 0.11,
			transparent: true,
			opacity: 0,
			blending: THREE.AdditiveBlending,
			depthWrite: false
		});
		const particles = new THREE.Points(pgeo, pmat);
		pack.add(particles);

		// idle ambient sparkles
		const sgeo = new THREE.BufferGeometry();
		const spos = new Float32Array(50 * 3);
		for (let i = 0; i < 50; i++) {
			spos[i * 3] = (Math.random() - 0.5) * 6;
			spos[i * 3 + 1] = (Math.random() - 0.5) * 7;
			spos[i * 3 + 2] = (Math.random() - 0.5) * 2 + 0.5;
		}
		sgeo.setAttribute('position', new THREE.BufferAttribute(spos, 3));
		const sparks = new THREE.Points(
			sgeo,
			new THREE.PointsMaterial({ color: new THREE.Color(color), size: 0.05, transparent: true, opacity: 0.6 })
		);
		scene.add(sparks);

		paintWrapper(null, false);
		frontTex.needsUpdate = true;

		// ── Real art loader (called now and whenever `art` arrives) ─
		host.__loadArt = (url, isProduct) => {
			if (!url) return;
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => {
				try {
					paintWrapper(img, isProduct);
					frontTex.needsUpdate = true;
					rim.color.copy(accent);
				} catch (e) {
					/* tainted / decode issue — keep the generated wrapper */
				}
			};
			img.src = url;
		};
		if (art) host.__loadArt(art, productPhoto);

		// ── Drag to inspect ────────────────────────────────────────
		let targetRY = 0,
			targetRX = 0,
			dragging = false,
			lastX = 0,
			lastY = 0;
		const el = renderer.domElement;
		const down = (e) => {
			dragging = true;
			hint = false;
			const p = e.touches ? e.touches[0] : e;
			lastX = p.clientX;
			lastY = p.clientY;
		};
		const move = (e) => {
			if (!dragging) return;
			const p = e.touches ? e.touches[0] : e;
			targetRY += (p.clientX - lastX) * 0.01;
			targetRX += (p.clientY - lastY) * 0.01;
			targetRX = Math.max(-0.6, Math.min(0.6, targetRX));
			lastX = p.clientX;
			lastY = p.clientY;
		};
		const up = () => {
			dragging = false;
		};
		el.addEventListener('pointerdown', down);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);

		// ── Animation loop ─────────────────────────────────────────
		let t = 0,
			ripT = -1,
			raf;
		function frame() {
			raf = requestAnimationFrame(frame);
			t += 0.016;

			// drift the environment so the foil streak keeps sweeping
			if (scene.environmentRotation) scene.environmentRotation.y = t * 0.12;

			if (ripT < 0) {
				const idleY = Math.sin(t * 0.8) * 0.26;
				pack.rotation.y += (targetRY + idleY - pack.rotation.y) * 0.1;
				pack.rotation.x += (targetRX - pack.rotation.x) * 0.1;
				pack.position.y = Math.sin(t * 1.4) * 0.1;
				sparks.rotation.y = t * 0.05;
			} else {
				ripT += 0.016;
				if (ripT < 0.35) {
					pack.rotation.z = Math.sin(ripT * 70) * 0.06;
					pack.position.x = Math.sin(ripT * 90) * 0.04;
				} else {
					pack.rotation.z *= 0.85;
					pack.position.x *= 0.85;
					const k = Math.min(1, (ripT - 0.35) / 0.6); // peel progress

					// tear the strip off along the seam, with a ragged wobble
					stripPivot.rotation.x = -k * 2.7;
					stripPivot.rotation.z = Math.sin(k * 12) * 0.12 * (1 - k);
					stripPivot.position.y = seamY + k * 1.4;
					stripFrontMat.transparent = stripBackMat.transparent = true;
					stripFrontMat.opacity = stripBackMat.opacity = Math.max(0, 1 - k * 1.3);

					// body tips back so you can see down into the opening
					body.rotation.x = k * 0.26;
					stack.position.y = seamY - PH * 0.05 + k * 0.07;

					const b = Math.sin(Math.min(1, k) * Math.PI);
					burst.material.opacity = b * 0.9;
					burst.scale.setScalar(0.2 + k * 3.2);
					pmat.opacity = b;
					const pa = particles.geometry.attributes.position.array;
					for (let i = 0; i < PN; i++) {
						pa[i * 3] += pvel[i][0];
						pa[i * 3 + 1] += pvel[i][1];
						pa[i * 3 + 2] += pvel[i][2];
					}
					particles.geometry.attributes.position.needsUpdate = true;

					if (k >= 1) {
						const f = Math.min(1, (ripT - 0.95) / 0.4);
						pack.position.y = -f * 1.6;
						pack.scale.setScalar(Math.max(0.001, 1 - f));
						for (const m of [bodyFrontMat, bodyBackMat, insideMat, stackMat]) {
							m.transparent = true;
							m.opacity = 1 - f;
						}
						if (f >= 1) {
							cancelAnimationFrame(raf);
							onripped();
							return;
						}
					}
				}
			}
			renderer.render(scene, camera);
		}
		frame();

		host.__rip = () => {
			if (ripT >= 0) return;
			ripT = 0;
			flash = true;
			setTimeout(() => (flash = false), 260);
		};

		function onResize() {
			const w = host.clientWidth,
				h = host.clientHeight;
			camera.aspect = w / h;
			camera.updateProjectionMatrix();
			renderer.setSize(w, h);
		}
		window.addEventListener('resize', onResize);

		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onResize);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			el.removeEventListener('pointerdown', down);
			scene.traverse((o) => {
				if (o.geometry) o.geometry.dispose();
				if (o.material) {
					const m = Array.isArray(o.material) ? o.material : [o.material];
					m.forEach((x) => x.dispose());
				}
			});
			for (const tx of [frontTex, backTex, normalTex, ormTex, burstTex, insideTex]) tx.dispose();
			scene.environment?.dispose();
			renderer.dispose();
			if (renderer.domElement.parentNode) renderer.domElement.remove();
		};
	});

	/**
	 * Bounding box of the pack inside a studio photo, minus the backdrop.
	 *
	 * Two passes. The first drops the flat backdrop using per-row and per-column
	 * coverage counts, so one stray pixel or JPEG ringing along the frame can't
	 * blow the box open. The second shaves the pale rim left behind — a sliver of
	 * backdrop plus the studio highlight burning along the pack's rolled edge —
	 * because anything left there gets stretched across the 3D roll as a white
	 * band. That pass is bounded by the shape of a real booster, so a genuinely
	 * white wrapper (Foundations Collector) keeps its design.
	 */
	function trimBox(img) {
		const w = img.naturalWidth || img.width;
		const h = img.naturalHeight || img.height;
		const full = { x: 0, y: 0, w, h };
		try {
			const c = document.createElement('canvas');
			c.width = w;
			c.height = h;
			const x = c.getContext('2d', { willReadFrequently: true });
			x.drawImage(img, 0, 0);
			const d = x.getImageData(0, 0, w, h).data;

			// backdrop = median of the border ring
			const ring = [];
			for (let i = 0; i < w; i += 3) ring.push([i, 0], [i, h - 1]);
			for (let j = 0; j < h; j += 3) ring.push([0, j], [w - 1, j]);
			const bg = [0, 1, 2].map((k) => {
				const a = ring.map(([px, py]) => d[(py * w + px) * 4 + k]).sort((p, q) => p - q);
				return a[a.length >> 1];
			});

			const off = (px, py) => {
				const i = (py * w + px) * 4;
				if (d[i + 3] < 16) return false;
				return (
					Math.abs(d[i] - bg[0]) > 26 || Math.abs(d[i + 1] - bg[1]) > 26 || Math.abs(d[i + 2] - bg[2]) > 26
				);
			};
			const rows = new Int32Array(h);
			const cols = new Int32Array(w);
			for (let py = 0; py < h; py++)
				for (let px = 0; px < w; px++)
					if (off(px, py)) {
						rows[py]++;
						cols[px]++;
					}
			const rowMin = Math.max(3, w * 0.06);
			const colMin = Math.max(3, h * 0.06);
			let x0 = 0,
				y0 = 0,
				x1 = w - 1,
				y1 = h - 1;
			while (y0 < h && rows[y0] < rowMin) y0++;
			while (y1 > y0 && rows[y1] < rowMin) y1--;
			while (x0 < w && cols[x0] < colMin) x0++;
			while (x1 > x0 && cols[x1] < colMin) x1--;
			if (x1 - x0 < w * 0.2 || y1 - y0 < h * 0.2) return full;

			// Judged against the pack's own brightness, not the backdrop's: what
			// survives pass one is a mix of leftover backdrop and studio glare, and
			// both are far brighter than the wrapper. Sampled over the body only —
			// the crimps are darker and wider than the body and would skew it.
			const lum = (px, py) => {
				const i = (py * w + px) * 4;
				return (d[i] + d[i + 1] + d[i + 2]) / 3;
			};
			const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
			const ya = Math.round(y0 + (y1 - y0) * 0.12);
			const yb = Math.round(y1 - (y1 - y0) * 0.12);
			const colLum = (px) => {
				const a = [];
				for (let py = ya; py <= yb; py += 2) a.push(lum(px, py));
				return med(a);
			};
			const inner = [];
			for (let px = Math.round(x0 + (x1 - x0) * 0.25); px <= Math.round(x1 - (x1 - x0) * 0.25); px += 2)
				inner.push(colLum(px));
			const limit = med(inner) + 55;
			const room = () => (x1 - x0 + 1) / (y1 - y0 + 1) > 0.5; // never narrower than a real pack
			while (room() && colLum(x0) > limit) x0++;
			while (room() && colLum(x1) > limit) x1--;

			return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
		} catch {
			return full;
		}
	}

	/** Dominant colour of the pack front, for the reverse and the rim light. */
	function sampleAccent(img, b) {
		try {
			const c = document.createElement('canvas');
			c.width = 16;
			c.height = 32;
			const x = c.getContext('2d', { willReadFrequently: true });
			x.drawImage(img, b.x, b.y + b.h * 0.12, b.w, b.h * 0.6, 0, 0, 16, 32);
			const d = x.getImageData(0, 0, 16, 32).data;
			let r = 0,
				gg = 0,
				bb = 0,
				n = 0;
			for (let i = 0; i < d.length; i += 4) {
				const mx = Math.max(d[i], d[i + 1], d[i + 2]);
				if (mx < 24) continue; // skip near-black, it carries no hue
				r += d[i];
				gg += d[i + 1];
				bb += d[i + 2];
				n++;
			}
			if (!n) return null;
			const col = new THREE.Color(r / n / 255, gg / n / 255, bb / n / 255);
			const hsl = {};
			col.getHSL(hsl);
			return col.setHSL(hsl.h, Math.min(0.85, hsl.s * 1.5 + 0.12), Math.min(0.62, Math.max(0.34, hsl.l * 1.25)));
		} catch {
			return null;
		}
	}

	/**
	 * Crinkle + crimp-comb height field, converted to a normal map, plus a
	 * packed roughness (G) / metalness (B) map for the same surface.
	 */
	function foilMaps(W, H, crimp, shoulder, ridges) {
		const hc = document.createElement('canvas');
		hc.width = W;
		hc.height = H;
		const x = hc.getContext('2d', { willReadFrequently: true });
		x.fillStyle = '#808080';
		x.fillRect(0, 0, W, H);

		// octaves of value noise — the fine grain of metallised film. Kept low:
		// a booster is slack film, not crumpled foil.
		for (const [cells, amp] of [
			[7, 0.2],
			[15, 0.12],
			[33, 0.07]
		]) {
			const n = document.createElement('canvas');
			n.width = cells;
			n.height = Math.max(2, Math.round((cells * H) / W));
			const ng = n.getContext('2d');
			const id = ng.createImageData(n.width, n.height);
			for (let i = 0; i < id.data.length; i += 4) {
				const v = Math.random() * 255;
				id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
				id.data[i + 3] = 255;
			}
			ng.putImageData(id, 0, 0);
			x.globalAlpha = amp;
			x.globalCompositeOperation = 'overlay';
			x.drawImage(n, 0, 0, W, H);
		}
		x.globalAlpha = 1;
		x.globalCompositeOperation = 'source-over';

		// long soft creases, drawn small and scaled up so they blur out
		const cc = document.createElement('canvas');
		cc.width = Math.round(W / 5);
		cc.height = Math.round(H / 5);
		const cg = cc.getContext('2d');
		cg.fillStyle = '#808080';
		cg.fillRect(0, 0, cc.width, cc.height);
		cg.lineCap = 'round';
		for (let i = 0; i < 9; i++) {
			const y0 = Math.random() * cc.height;
			cg.strokeStyle = i % 2 ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)';
			cg.lineWidth = 1 + Math.random() * 2;
			cg.beginPath();
			cg.moveTo(-4, y0);
			cg.bezierCurveTo(
				cc.width * 0.3,
				y0 + (Math.random() - 0.5) * 22,
				cc.width * 0.7,
				y0 + (Math.random() - 0.5) * 22,
				cc.width + 4,
				y0 + (Math.random() - 0.5) * 30
			);
			cg.stroke();
		}
		x.globalAlpha = 0.32;
		x.globalCompositeOperation = 'overlay';
		x.drawImage(cc, 0, 0, W, H);
		x.globalAlpha = 1;
		x.globalCompositeOperation = 'source-over';

		// the crimp comb: sharp vertical ridges, full amplitude
		const bandH = Math.round(H * crimp);
		const pitch = W / ridges;
		for (const y0 of [0, H - bandH]) {
			x.fillStyle = '#3a3a3a';
			x.fillRect(0, y0, W, bandH);
			for (let i = 0; i < ridges; i++) {
				const gx = x.createLinearGradient(i * pitch, 0, (i + 1) * pitch, 0);
				gx.addColorStop(0, '#151515');
				gx.addColorStop(0.45, '#f2f2f2');
				gx.addColorStop(0.62, '#a8a8a8');
				gx.addColorStop(1, '#151515');
				x.fillStyle = gx;
				x.fillRect(i * pitch, y0 + 1, pitch, bandH - 2);
			}
		}
		// a raised crease where the film folds out of each crimp
		for (const [y0, dir] of [
			[bandH, 1],
			[H - bandH, -1]
		]) {
			const fh = Math.round(H * shoulder * 0.5);
			const fg = x.createLinearGradient(0, y0, 0, y0 + dir * fh);
			fg.addColorStop(0, 'rgba(255,255,255,0.45)');
			fg.addColorStop(0.35, 'rgba(128,128,128,0.4)');
			fg.addColorStop(1, 'rgba(0,0,0,0)');
			x.fillStyle = fg;
			x.fillRect(0, dir > 0 ? y0 : y0 - fh, W, fh);
		}

		// height field → normals (Sobel)
		const src = x.getImageData(0, 0, W, H).data;
		const nc = document.createElement('canvas');
		nc.width = W;
		nc.height = H;
		const nctx = nc.getContext('2d');
		const out = nctx.createImageData(W, H);
		const hAt = (px, py) => {
			const cx2 = px < 0 ? 0 : px >= W ? W - 1 : px;
			const cy2 = py < 0 ? 0 : py >= H ? H - 1 : py;
			return src[(cy2 * W + cx2) * 4] / 255;
		};
		const S = 2.4;
		for (let py = 0; py < H; py++) {
			for (let px = 0; px < W; px++) {
				const dX =
					hAt(px + 1, py - 1) + 2 * hAt(px + 1, py) + hAt(px + 1, py + 1) -
					(hAt(px - 1, py - 1) + 2 * hAt(px - 1, py) + hAt(px - 1, py + 1));
				const dY =
					hAt(px - 1, py + 1) + 2 * hAt(px, py + 1) + hAt(px + 1, py + 1) -
					(hAt(px - 1, py - 1) + 2 * hAt(px, py - 1) + hAt(px + 1, py - 1));
				let nx = -dX * S,
					ny = dY * S,
					nz = 1;
				const len = Math.hypot(nx, ny, nz);
				const i = (py * W + px) * 4;
				out.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
				out.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
				out.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
				out.data[i + 3] = 255;
			}
		}
		nctx.putImageData(out, 0, 0);

		// roughness (G) + metalness (B): printed film is satin, bare crimp is
		// brighter metal, and the creases scuff rougher
		const oc = document.createElement('canvas');
		oc.width = W;
		oc.height = H;
		const og = oc.getContext('2d');
		const orm = og.createImageData(W, H);
		// The outermost columns land on the pack's rolled side edges, which face
		// the viewer at a grazing angle. Left glossy they mirror the environment
		// into a white stripe, so they get scuffed matte instead.
		const rollPx = Math.max(2, Math.round(W * 0.02));
		for (let py = 0; py < H; py++) {
			const inCrimp = py < bandH || py >= H - bandH;
			for (let px = 0; px < W; px++) {
				const i = (py * W + px) * 4;
				const n = src[i] / 255;
				let rough = inCrimp ? 0.4 + n * 0.24 : 0.24 + n * 0.2;
				let metal = inCrimp ? 0.5 : 0.26 + n * 0.1;
				const roll = 1 - Math.min(1, Math.min(px, W - 1 - px) / rollPx);
				if (roll > 0) {
					rough += (0.72 - rough) * roll;
					metal += (0.1 - metal) * roll;
				}
				orm.data[i] = 255;
				orm.data[i + 1] = Math.round(rough * 255);
				orm.data[i + 2] = Math.round(metal * 255);
				orm.data[i + 3] = 255;
			}
		}
		og.putImageData(orm, 0, 0);

		const normal = new THREE.CanvasTexture(nc);
		const ormT = new THREE.CanvasTexture(oc);
		return { normal, orm: ormT };
	}

	/** Edges of the card stack, seen through the opening. */
	function stackTexture() {
		const c = document.createElement('canvas');
		c.width = 8;
		c.height = 64;
		const x = c.getContext('2d');
		x.fillStyle = '#161a24';
		x.fillRect(0, 0, 8, 64);
		for (let i = 0; i < 22; i++) {
			const y = 2 + i * 2.8;
			x.fillStyle = i % 2 ? '#cfd6e4' : '#8e97a8';
			x.fillRect(0, y, 8, 1.6);
		}
		const sh = x.createLinearGradient(0, 0, 0, 64);
		sh.addColorStop(0, 'rgba(255,255,255,0.25)');
		sh.addColorStop(0.5, 'rgba(0,0,0,0.35)');
		sh.addColorStop(1, 'rgba(0,0,0,0.8)');
		x.fillStyle = sh;
		x.fillRect(0, 0, 8, 64);
		const tex = new THREE.CanvasTexture(c);
		tex.colorSpace = THREE.SRGBColorSpace;
		return tex;
	}

	function radialTexture(colorHex) {
		const c = document.createElement('canvas');
		c.width = c.height = 128;
		const x = c.getContext('2d');
		const grd = x.createRadialGradient(64, 64, 0, 64, 64, 64);
		grd.addColorStop(0, '#ffffff');
		grd.addColorStop(0.3, colorHex);
		grd.addColorStop(1, 'rgba(0,0,0,0)');
		x.fillStyle = grd;
		x.fillRect(0, 0, 128, 128);
		const tex = new THREE.CanvasTexture(c);
		tex.colorSpace = THREE.SRGBColorSpace;
		return tex;
	}

	function measureLines(ctx, text, maxWidth) {
		const words = text.split(' ');
		let line = '';
		const lines = [];
		for (const w of words) {
			const test = line ? line + ' ' + w : w;
			if (ctx.measureText(test).width > maxWidth && line) {
				lines.push(line);
				line = w;
			} else line = test;
		}
		lines.push(line);
		return lines;
	}

	function wrapText(ctx, text, x, y, maxWidth, lh, fillStyle) {
		const lines = measureLines(ctx, text, maxWidth);
		const startY = y - ((lines.length - 1) * lh) / 2;
		lines.forEach((l, i) => {
			if (ctx.lineWidth) ctx.strokeText(l, x, startY + i * lh);
			ctx.fillStyle = fillStyle ?? ctx.fillStyle;
			ctx.fillText(l, x, startY + i * lh);
		});
	}

	// Repaint with real art whenever the URL arrives (fetched async by parent).
	$effect(() => {
		const url = art;
		const isProduct = productPhoto;
		if (url && host?.__loadArt) host.__loadArt(url, isProduct);
	});

	export function rip() {
		hint = false;
		host?.__rip?.();
	}
</script>

<div class="relative w-full h-full select-none touch-none grid place-items-center" bind:this={host}>
	{#if noWebGL}
		<!-- 2D fallback pack (no WebGL) — same 70×133 shape, crimped ends -->
		<div
			class="relative w-[52%] max-w-[220px] aspect-[263/500] overflow-hidden shadow-2xl {flash ? 'ring-4 ring-white' : ''}"
			style="background: linear-gradient(160deg, {color}, #0a0d16);"
		>
			{#if art}
				<img src={art} alt="" class="absolute inset-0 w-full h-full object-cover" />
			{/if}
			{#if !productPhoto}
				<div class="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/85"></div>
				<div class="absolute inset-x-0 top-[6.2%] text-center text-white font-black text-[0.7rem] tracking-widest">
					⚡ PACKRIPPER
				</div>
				<div class="absolute inset-x-0 bottom-[9%] px-2 text-center">
					<div class="text-white font-black leading-tight text-sm" style="font-family: Georgia, serif;">
						{setName}
					</div>
					<div class="mt-1 bg-white/90 text-[0.6rem] font-black text-slate-900 py-0.5 tracking-widest">
						{packName?.toUpperCase()}
					</div>
					<div class="text-white/60 text-[0.55rem] mt-1 tracking-widest">{cardCount} CARDS</div>
				</div>
			{/if}
			<!-- crimped seals -->
			<div
				class="absolute inset-x-0 top-0 h-[6.2%]"
				style="background-image: repeating-linear-gradient(90deg, rgba(0,0,0,.55) 0 1px, rgba(255,255,255,.18) 1px 2px, rgba(0,0,0,.55) 2px 4px), linear-gradient(180deg, #0006, #0009); background-blend-mode: overlay; box-shadow: inset 0 -2px 3px #000a;"
			></div>
			<div
				class="absolute inset-x-0 bottom-0 h-[6.2%]"
				style="background-image: repeating-linear-gradient(90deg, rgba(0,0,0,.55) 0 1px, rgba(255,255,255,.18) 1px 2px, rgba(0,0,0,.55) 2px 4px), linear-gradient(0deg, #0006, #0009); background-blend-mode: overlay; box-shadow: inset 0 2px 3px #000a;"
			></div>
		</div>
	{/if}
	{#if hint && !noWebGL}
		<div class="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-base-content/50">
			drag to inspect
		</div>
	{/if}
	{#if flash}
		<div
			class="pointer-events-none absolute inset-0 bg-white/70 animate-[fade_0.26s_ease-out]"
			style="animation: none; opacity: 0.6;"
		></div>
	{/if}
</div>
