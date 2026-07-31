<script>
	/**
	 * A single card, big, in 3D, and in your hands.
	 *
	 * Three things it does that a picture in a modal does not:
	 *
	 *   * It has a BACK. For a transforming or modal double-faced card that back is
	 *     the real second face, fetched from /api/card-faces the first time the card
	 *     is opened; for everything else it is a printed back drawn here. A card you
	 *     can only see one side of is a picture, not a card.
	 *   * It TILTS. The whole thing lives in a perspective container, and the tilt
	 *     follows the pointer, which is what makes the foil overlay read as foil —
	 *     a static gradient labelled "foil" does not.
	 *   * It MOVES. Drag it anywhere on the screen and it comes with you.
	 *
	 * Drag and flip share the pointer, and the rule that separates them is the one
	 * physical objects use: a drag that went nowhere was a tap. Movement under
	 * TAP_SLOP pixels flips the card, anything more moves it, so neither gesture
	 * needs a handle and the whole card stays grabbable.
	 */
	import { formatGold } from '$lib/economy.js';
	import { rarityInfo, cardImage, marketGold, sellGold, treatmentsOf, treatmentInfo, finishLabel } from '$lib/cards.js';

	let {
		card,
		/** Rendered in the footer — the sell button on the collection screen. */
		actions = null,
		onclose = () => {}
	} = $props();

	/** Pointer travel under this many pixels counts as a tap rather than a drag. */
	const TAP_SLOP = 6;

	const r = $derived(rarityInfo(card.rarity));
	const treatments = $derived(card.treatments?.length ? card.treatments : treatmentsOf(card));
	const finish = $derived(finishLabel(card));

	// ── Faces ──────────────────────────────────────────────────
	// Asked for once per card, and only when the card is opened. The front renders
	// immediately from the image the collection already carries; the fetch upgrades
	// it to the full-resolution printing and supplies the back if there is one.
	let faces = $state(null);
	let loadingFaces = $state(true);

	$effect(() => {
		const id = card?.id;
		faces = null;
		loadingFaces = true;
		if (!id) {
			loadingFaces = false;
			return;
		}
		let live = true;
		fetch(`/api/card-faces/${id}`)
			.then((res) => (res.ok ? res.json() : null))
			.then((body) => {
				if (!live) return;
				faces = body?.faces?.length ? body.faces : null;
				loadingFaces = false;
			})
			.catch(() => {
				if (live) loadingFaces = false;
			});
		return () => {
			live = false;
		};
	});

	const frontImage = $derived(faces?.[0]?.image || cardImage(card, 'large') || cardImage(card, 'normal'));
	/** The real second face, when this printing has one. */
	const backImage = $derived(faces && faces.length > 1 ? faces[1].image : null);
	const backName = $derived(faces && faces.length > 1 ? faces[1].name : null);

	// ── Motion ─────────────────────────────────────────────────
	let x = $state(0);
	let y = $state(0);
	let tiltX = $state(0);
	let tiltY = $state(0);
	let flipped = $state(false);
	let dragging = $state(false);
	let lifted = $state(false);

	let start = { x: 0, y: 0, ox: 0, oy: 0 };
	let travelled = 0;
	let node;

	function down(e) {
		// Ignore the secondary buttons: a right-click is a context menu, not a grab.
		if (e.button !== undefined && e.button !== 0) return;
		node?.setPointerCapture?.(e.pointerId);
		dragging = true;
		lifted = true;
		travelled = 0;
		start = { x: e.clientX, y: e.clientY, ox: x, oy: y };
	}

	function move(e) {
		if (!dragging) {
			// Not held: the tilt tracks the pointer across the card, so the foil and the
			// lighting move the way they would if you turned it in the light.
			hover(e);
			return;
		}
		const dx = e.clientX - start.x;
		const dy = e.clientY - start.y;
		travelled = Math.max(travelled, Math.abs(dx) + Math.abs(dy));
		x = start.ox + dx;
		y = start.oy + dy;
		// Tilt away from the direction of travel, clamped — a card being dragged
		// leans, and the clamp is what stops a fast flick spinning it edge-on.
		tiltY = Math.max(-22, Math.min(22, dx * 0.12));
		tiltX = Math.max(-18, Math.min(18, -dy * 0.1));
	}

	function up(e) {
		if (!dragging) return;
		dragging = false;
		lifted = false;
		node?.releasePointerCapture?.(e.pointerId);
		if (travelled < TAP_SLOP) flipped = !flipped;
		tiltX = 0;
		tiltY = 0;
	}

	/** Tilt from where the pointer is over the card, in card-relative coordinates. */
	function hover(e) {
		const box = node?.getBoundingClientRect();
		if (!box) return;
		const px = (e.clientX - box.left) / box.width - 0.5;
		const py = (e.clientY - box.top) / box.height - 0.5;
		tiltY = px * 26;
		tiltX = -py * 20;
	}

	function leave() {
		if (dragging) return;
		tiltX = 0;
		tiltY = 0;
	}

	function reset() {
		x = 0;
		y = 0;
		tiltX = 0;
		tiltY = 0;
		flipped = false;
	}

	function key(e) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			flipped = !flipped;
		} else if (e.key === 'r' || e.key === 'R') {
			reset();
		}
	}

	// The flip is the only rotation applied to the inner element, so the tilt on the
	// outer one keeps working the same way on both sides.
	const tilt = $derived(`translate3d(${x}px, ${y}px, 0) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`);
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- The scrim closes on a click that started AND ended on it, so releasing a drag
     that wandered off the card does not dismiss the whole viewer. -->
<div
	class="c3-scrim"
	role="presentation"
	onpointerdown={(e) => {
		if (e.target === e.currentTarget) e.currentTarget.dataset.armed = '1';
	}}
	onpointerup={(e) => {
		if (e.target === e.currentTarget && e.currentTarget.dataset.armed === '1') onclose();
		delete e.currentTarget.dataset.armed;
	}}
>
	<div class="c3-stage" role="dialog" aria-modal="true" aria-label={card.name}>
		<div class="c3-perspective">
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				bind:this={node}
				class="c3-card"
				class:c3-lifted={lifted}
				class:c3-flipped={flipped}
				class:c3-dragging={dragging}
				style="transform: {tilt}"
				role="button"
				tabindex="0"
				aria-label="{card.name} — press Enter to turn over, R to reset"
				onpointerdown={down}
				onpointermove={move}
				onpointerup={up}
				onpointercancel={up}
				onpointerleave={leave}
				onkeydown={key}
			>
				<div class="c3-face c3-front {r.ring}">
					{#if frontImage}
						<img src={frontImage} alt={card.name} draggable="false" />
					{:else}
						<div class="c3-blank">
							<div class="font-bold {r.text}">{card.name}</div>
							<div class="text-xs opacity-60 mt-1">{r.label}</div>
						</div>
					{/if}
					{#if card.foil}<div class="c3-foil"></div>{/if}
					<div class="c3-gloss"></div>
				</div>

				<div class="c3-face c3-back">
					{#if backImage}
						<img src={backImage} alt={backName ?? 'Reverse face'} draggable="false" />
						{#if card.foil}<div class="c3-foil"></div>{/if}
						<div class="c3-gloss"></div>
					{:else}
						<!-- The printed back. Drawn rather than an image: a single-faced card's
						     reverse is the same for every card, so it is a template, not an asset. -->
						<div class="c3-printed">
							<div class="c3-printed-panel">
								<div class="c3-printed-mark">⚡</div>
								<div class="c3-printed-word">Pack<span>Ripper</span></div>
							</div>
						</div>
					{/if}
				</div>
			</div>
		</div>

		<!-- ── readout ──────────────────────────────────────────── -->
		<div class="c3-info">
			<div class="flex items-start gap-2">
				<div class="min-w-0 flex-1">
					<div class="font-bold leading-tight truncate">
						{flipped && backName ? backName : card.name}
					</div>
					<div class="text-xs text-base-content/50 truncate">
						{card.setName || String(card.set || '').toUpperCase()}{card.number ? ` · #${card.number}` : ''}
					</div>
				</div>
				<button class="btn btn-ghost btn-xs btn-circle shrink-0" onclick={onclose} aria-label="Close">✕</button>
			</div>

			<div class="flex flex-wrap gap-1 mt-2">
				<span class="badge badge-sm {r.badge}">{r.label}</span>
				{#if card.serial}
					<span class="badge badge-sm bg-gradient-to-r from-amber-300 via-fuchsia-400 to-cyan-300 text-black border-0 font-black">
						#{card.serial}/{card.serialOf}
					</span>
				{/if}
				{#if finish}
					<span class="badge badge-sm bg-gradient-to-r from-cyan-400 to-fuchsia-400 text-black border-0 font-bold">{finish}</span>
				{/if}
				{#each treatments.slice(0, 3) as t}
					{@const info = treatmentInfo(t)}
					{#if info}<span class="badge badge-sm border-0 font-bold {info.cls}">{info.label}</span>{/if}
				{/each}
			</div>

			<div class="flex items-baseline gap-4 mt-2 text-sm">
				<span>Market <span class="font-bold text-accent">🪙{formatGold(marketGold(card))}</span></span>
				<span class="text-base-content/60">Sells for <span class="font-bold">🪙{formatGold(sellGold(card))}</span></span>
			</div>

			<div class="flex flex-wrap items-center gap-2 mt-3">
				<button class="btn btn-sm btn-outline" onclick={() => (flipped = !flipped)}>
					{#if loadingFaces && card.id}
						<span class="loading loading-spinner loading-xs"></span>
					{/if}
					{flipped ? 'Show front' : backImage ? 'Turn over' : 'Show back'}
				</button>
				<button class="btn btn-sm btn-ghost border border-white/10" onclick={reset}>Recentre</button>
				{#if card.scryfallUri}
					<a href={card.scryfallUri} target="_blank" rel="noopener" class="link link-primary text-xs">
						Scryfall ↗
					</a>
				{/if}
				{#if actions}
					<span class="ml-auto">{@render actions(card)}</span>
				{/if}
			</div>

			<p class="text-[0.65rem] text-base-content/35 mt-2">
				Drag to move it, tap to turn it over{backImage ? ' — this one has a real second face' : ''}.
			</p>
		</div>
	</div>
</div>

<style>
	.c3-scrim {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: rgba(4, 2, 12, 0.82);
		backdrop-filter: blur(6px);
		/* The card is dragged with a pointer, so nothing in here should also be
		   interpreted as a scroll or a text selection. */
		touch-action: none;
		overscroll-behavior: contain;
	}

	.c3-stage {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		width: 100%;
		max-width: 30rem;
	}

	/* Perspective belongs to the container, not the card: put it on the card and it
	   moves with the card's own translation, and the vanishing point slides around
	   as you drag. */
	.c3-perspective {
		perspective: 1100px;
		perspective-origin: 50% 45%;
		display: grid;
		place-items: center;
		width: 100%;
	}

	.c3-card {
		/* Deliberately large: this is the "bigger on screen" view, so it takes as
		   much of the viewport as the card's 5:7 shape allows in either direction. */
		width: min(74vw, 22rem, calc(58vh * 5 / 7));
		aspect-ratio: 5 / 7;
		position: relative;
		transform-style: preserve-3d;
		cursor: grab;
		border-radius: 4.7% / 3.36%;
		transition:
			transform 0.28s cubic-bezier(0.22, 1, 0.36, 1),
			filter 0.2s ease;
		filter: drop-shadow(0 1.2rem 2rem rgba(0, 0, 0, 0.6));
		will-change: transform;
		outline: none;
	}
	/* No easing while a finger is down — a transition on a dragged element lags
	   behind the pointer and feels broken. */
	.c3-card.c3-dragging {
		transition: filter 0.2s ease;
		cursor: grabbing;
	}
	.c3-card.c3-lifted {
		filter: drop-shadow(0 2rem 3rem rgba(0, 0, 0, 0.7));
	}
	.c3-card:focus-visible {
		outline: 2px solid var(--color-primary, #c084fc);
		outline-offset: 6px;
	}

	.c3-face {
		position: absolute;
		inset: 0;
		border-radius: inherit;
		overflow: hidden;
		backface-visibility: hidden;
		background: #0b0716;
		border: 1px solid rgba(255, 255, 255, 0.08);
		transition: transform 0.55s cubic-bezier(0.22, 1, 0.36, 1);
	}
	.c3-front {
		transform: rotateY(0deg);
	}
	.c3-back {
		transform: rotateY(180deg);
	}
	.c3-flipped .c3-front {
		transform: rotateY(-180deg);
	}
	.c3-flipped .c3-back {
		transform: rotateY(0deg);
	}

	.c3-face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		user-select: none;
		-webkit-user-drag: none;
	}
	.c3-blank {
		display: grid;
		place-items: center;
		height: 100%;
		padding: 1rem;
		text-align: center;
	}

	/* A moving highlight, so the card reads as a physical surface under a light
	   rather than a flat image. Pointer-transparent — the card underneath is what
	   the gestures are on. */
	.c3-gloss {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: linear-gradient(
			125deg,
			rgba(255, 255, 255, 0) 38%,
			rgba(255, 255, 255, 0.22) 50%,
			rgba(255, 255, 255, 0) 62%
		);
		mix-blend-mode: screen;
		opacity: 0.55;
	}
	.c3-foil {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: linear-gradient(
			115deg,
			rgba(255, 0, 128, 0.28),
			rgba(255, 214, 0, 0.28),
			rgba(0, 255, 200, 0.28),
			rgba(120, 80, 255, 0.28)
		);
		mix-blend-mode: color-dodge;
		opacity: 0.5;
	}

	/* ── the printed back ──────────────────────────────────────── */
	.c3-printed {
		height: 100%;
		padding: 5%;
		background:
			radial-gradient(circle at 50% 38%, rgba(168, 85, 247, 0.28), transparent 62%),
			linear-gradient(160deg, #241436 0%, #140c22 45%, #0a0612 100%);
		display: grid;
		place-items: center;
	}
	.c3-printed-panel {
		width: 100%;
		height: 100%;
		border-radius: 6%;
		border: 2px solid rgba(240, 180, 41, 0.35);
		box-shadow:
			inset 0 0 0 4px rgba(0, 0, 0, 0.45),
			inset 0 0 3rem rgba(168, 85, 247, 0.25);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.6rem;
	}
	.c3-printed-mark {
		font-size: clamp(2.5rem, 13vw, 5rem);
		line-height: 1;
		filter: drop-shadow(0 0 1.4rem rgba(250, 204, 21, 0.55));
	}
	.c3-printed-word {
		font-weight: 900;
		letter-spacing: 0.02em;
		font-size: clamp(0.9rem, 4vw, 1.5rem);
		color: rgba(255, 255, 255, 0.82);
	}
	.c3-printed-word span {
		color: #c084fc;
	}

	.c3-info {
		width: 100%;
		border-radius: 1rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(18, 14, 30, 0.92);
		padding: 0.85rem 1rem;
		/* The readout is not the card — normal interaction applies here. */
		touch-action: auto;
	}

	@media (min-width: 64rem) {
		.c3-stage {
			max-width: 34rem;
		}
		.c3-card {
			width: min(30rem, calc(64vh * 5 / 7));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.c3-card,
		.c3-face {
			transition: none;
		}
	}
</style>
