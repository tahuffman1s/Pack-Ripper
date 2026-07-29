<script>
	import { onMount } from 'svelte';
	import { REELS, STOPS, ROWS, SYMBOLS, PAYLINES } from '$lib/slots.js';

	let {
		/** Cells to light up, as `"reel:row"` strings. */
		lit = new Set(),
		/** Winning paylines to trace over the window: `{ line, rows }`. */
		winLines = [],
		/** How many paylines are being played, for the edge markers. */
		lines = PAYLINES.length,
		onlanded = () => {}
	} = $props();

	const NREELS = REELS.length;

	// A reel's position is a real number of stops, and the stop at `pos` sits in
	// the MIDDLE row — so the window reads pos-1, pos, pos+1 from top to bottom.
	// That is exactly the window `gridFor()` computes, which is what keeps the
	// picture on screen and the server's scoring in agreement. Get it backwards
	// and the reels silently disagree with the result the server paid out on.

	/** Extra cells above and below the window, so a moving reel never shows a gap. */
	const BUFFER = 2;
	const CELLS_PER_REEL = ROWS + BUFFER * 2;

	const SPIN_SPEED = 26; // stops per second while free-running
	const EASE = 7; // approach rate once a reel has a target
	const MAX_BLUR = 4.5; // px of motion blur at full speed

	const symbolAt = (reel, j) => REELS[reel][((j % STOPS) + STOPS) % STOPS];

	/** The handful of cells that can be seen (or nearly seen) at this position. */
	function viewFor(reel, pos, blur) {
		const first = Math.floor(pos) - BUFFER;
		const cells = [];
		for (let j = first; j < first + CELLS_PER_REEL; j++) {
			cells.push({ y: j - pos + 1, sym: SYMBOLS[symbolAt(reel, j)] });
		}
		return { cells, blur };
	}

	// Motion lives in a plain array; only the rendered snapshot is reactive, so a
	// frame costs one assignment instead of a write per reel per tick.
	const reels = REELS.map(() => ({ pos: 0, velocity: 0, target: null, stopAt: 0, settled: true }));
	let view = $state(reels.map((r, i) => viewFor(i, r.pos, 0)));

	let pending = null;
	let landedFired = false;
	let quick = false; // honouring prefers-reduced-motion

	function blurFor(r) {
		if (r.settled) return 0;
		if (r.target === null) return MAX_BLUR;
		return Math.min(MAX_BLUR, Math.abs(r.target - r.pos) * 1.4);
	}

	/**
	 * Land on `stop` after at least one more full revolution. Reels only ever run
	 * one way, so the target is the nearest landing at or below that floor.
	 */
	function lockTarget(r, stop) {
		const ceiling = r.pos - (quick ? 1 : STOPS);
		r.target = stop + STOPS * Math.floor((ceiling - stop) / STOPS);
	}

	let raf = 0;
	let last = 0;
	let running = false;
	let disposed = false;

	function frame(t) {
		if (disposed) return;
		const now = t / 1000;
		const dt = last ? Math.min(now - last, 0.05) : 0;
		last = now;

		let moved = false;
		let allSettled = true;
		reels.forEach((r, i) => {
			if (r.settled) return;
			allSettled = false;
			moved = true;
			if (r.target === null) {
				r.pos -= r.velocity * dt;
				if (now >= r.stopAt && pending) lockTarget(r, pending[i]);
			} else {
				// Ease in, clamped so the approach never outruns the free spin.
				const remaining = r.target - r.pos; // always negative
				r.pos += Math.max(remaining * Math.min(1, dt * EASE), -r.velocity * dt);
				if (Math.abs(r.target - r.pos) < 0.002) {
					// Snap, and fold the position back into one revolution so it cannot
					// drift into imprecision over a long session.
					r.pos = ((r.target % STOPS) + STOPS) % STOPS;
					r.target = null;
					r.settled = true;
				}
			}
		});

		if (moved) view = reels.map((r, i) => viewFor(i, r.pos, blurFor(r)));

		if (allSettled && pending && !landedFired) {
			landedFired = true;
			pending = null;
			onlanded();
		}

		// Idle machines cost nothing: the loop only runs between the button and
		// the landing, then parks itself until the next spin.
		if (allSettled && !pending) {
			running = false;
			return;
		}
		raf = requestAnimationFrame(frame);
	}

	export function spinTo(stops) {
		pending = stops;
		landedFired = false;
		quick = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		const now = performance.now() / 1000;
		reels.forEach((r, i) => {
			r.settled = false;
			r.target = null;
			r.velocity = SPIN_SPEED + i * 2;
			// Land left to right, the way a mechanical machine does.
			r.stopAt = now + (quick ? 0.1 + i * 0.05 : 0.85 + i * 0.36);
		});
		if (!running && !disposed) {
			running = true;
			last = 0;
			raf = requestAnimationFrame(frame);
		}
	}

	onMount(() => () => {
		disposed = true;
		cancelAnimationFrame(raf);
	});

	// ── Payline overlay ────────────────────────────────────────────
	// The window is a gapless grid, so a cell centre is simply
	// (reel + 0.5, row + 0.5) in viewBox units. Separation between the reels is
	// drawn on top as posts rather than laid out as gaps, which keeps this honest.
	const LINE_COLORS = ['#fbbf24', '#22d3ee', '#f472b6', '#a3e635', '#c084fc'];
	const pathFor = (rows) => rows.map((row, reel) => `${reel + 0.5},${row + 0.5}`).join(' ');

	const winningLineIdx = $derived(new Set(winLines.map((lw) => lw.line)));
	const activeLines = $derived(PAYLINES.slice(0, lines));

	/**
	 * Edge markers grouped by the row a line enters (end 0) or leaves (end 2) on.
	 * They have to be grouped: at five lines both the top row and the bottom row
	 * are shared by a straight line and a diagonal, so one marker per row would
	 * stack two badges on top of each other.
	 */
	function railFor(end) {
		const rows = Array.from({ length: ROWS }, () => []);
		activeLines.forEach((pl, i) => rows[pl.rows[end]].push(i));
		return rows;
	}
	const leftRail = $derived(railFor(0));
	const rightRail = $derived(railFor(2));
	const tint = (i) => LINE_COLORS[i % LINE_COLORS.length];
</script>

<div class="mm">
	<!-- Left payline markers -->
	<div class="mm-rail">
		{#each leftRail as group, row}
			<div class="mm-group" style="--row:{row}">
				{#each group as i}
					<span
						class="mm-pip"
						class:mm-pip-win={winningLineIdx.has(i)}
						style="--tint:{tint(i)}"
						title={PAYLINES[i].name}>{i + 1}</span
					>
				{/each}
			</div>
		{/each}
	</div>

	<div class="mm-window">
		{#each view as reel, i}
			<div class="mm-reel">
				<div class="mm-strip" style="filter:blur({reel.blur}px)">
					{#each reel.cells as c}
						<div
							class="mm-cell"
							style="transform:translateY(calc(var(--cell) * {c.y})); background:{c.sym.color}; color:{c.sym
								.text}"
						>
							{c.sym.glyph}
						</div>
					{/each}
				</div>

				{#each Array(ROWS) as _, row}
					{#if lit.has(`${i}:${row}`)}
						<div class="mm-lit" style="--row:{row}"></div>
					{/if}
				{/each}
			</div>
		{/each}

		<!-- Gold posts between and beside the reels -->
		{#each Array(NREELS + 1) as _, i}
			<div class="mm-post" style="--at:{i / NREELS}"></div>
		{/each}

		{#if winLines.length}
			<svg class="mm-lines" viewBox="0 0 {NREELS} {ROWS}" preserveAspectRatio="none" aria-hidden="true">
				{#each winLines as lw}
					<polyline
						points={pathFor(lw.rows)}
						fill="none"
						stroke={tint(lw.line)}
						stroke-width="3"
						stroke-linecap="round"
						stroke-linejoin="round"
						vector-effect="non-scaling-stroke"
					/>
				{/each}
			</svg>
		{/if}
	</div>

	<!-- Right payline markers -->
	<div class="mm-rail">
		{#each rightRail as group, row}
			<div class="mm-group" style="--row:{row}">
				{#each group as i}
					<span
						class="mm-pip"
						class:mm-pip-win={winningLineIdx.has(i)}
						style="--tint:{tint(i)}"
						title={PAYLINES[i].name}>{i + 1}</span
					>
				{/each}
			</div>
		{/each}
	</div>
</div>

<style>
	.mm {
		--cell: clamp(3rem, 19vw, 5rem);
		--pad: 3px;
		display: flex;
		align-items: stretch;
		justify-content: center;
		gap: 0.4rem;
		padding: 0.75rem 0.35rem;
	}

	/* On a desktop the window has a column to itself, so the cells grow into it
	   rather than leaving the machine a phone-sized picture in a wide frame. */
	@media (min-width: 64rem) {
		.mm {
			--cell: 6.5rem;
			--pad: 4px;
			gap: 0.9rem;
			padding: 1.5rem 1rem;
		}
		.mm-rail {
			width: 2.8rem;
		}
		.mm-pip {
			width: 1.35rem;
			height: 1.35rem;
			font-size: 0.72rem;
		}
	}
	@media (min-width: 80rem) {
		.mm {
			--cell: 7.5rem;
		}
	}
	@media (min-width: 96rem) {
		.mm {
			--cell: 8.5rem;
		}
	}

	/* Numbered payline markers down each side */
	.mm-rail {
		position: relative;
		width: 2.4rem;
		flex: none;
	}
	.mm-group {
		position: absolute;
		top: calc(var(--cell) * (var(--row) + 0.5));
		left: 0;
		right: 0;
		translate: 0 -50%;
		display: flex;
		justify-content: center;
		gap: 0.15rem;
	}
	.mm-pip {
		display: grid;
		place-items: center;
		width: 1.1rem;
		height: 1.1rem;
		flex: none;
		border-radius: 999px;
		font-size: 0.65rem;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		color: color-mix(in srgb, var(--tint) 70%, white);
		background: color-mix(in srgb, var(--tint) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--tint) 40%, transparent);
		transition: all 0.18s ease;
	}
	.mm-pip-win {
		color: #1c1917;
		background: var(--tint);
		border-color: white;
		box-shadow: 0 0 0.6rem var(--tint);
		scale: 1.15;
	}

	/* The window: a gapless ROWS x NREELS grid of cells */
	.mm-window {
		position: relative;
		flex: none;
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: var(--cell);
		height: calc(var(--cell) * 3);
		overflow: hidden;
		border-radius: 0.85rem;
		background: #0b0716;
		box-shadow:
			inset 0 0 0 2px rgba(240, 180, 41, 0.55),
			inset 0 1.2rem 1.6rem -0.9rem rgba(0, 0, 0, 0.95),
			inset 0 -1.2rem 1.6rem -0.9rem rgba(0, 0, 0, 0.95),
			0 0.6rem 2rem rgba(0, 0, 0, 0.5);
	}

	.mm-reel {
		position: relative;
		overflow: hidden;
	}
	/* Blur lives on the strip, not the reel, so motion blur is clipped to its
	   own column instead of bleeding onto the neighbouring reels. */
	.mm-strip {
		position: absolute;
		inset: 0;
		will-change: filter;
	}

	.mm-cell {
		position: absolute;
		top: var(--pad);
		left: var(--pad);
		right: var(--pad);
		height: calc(var(--cell) - var(--pad) * 2);
		display: grid;
		place-items: center;
		border-radius: 0.5rem;
		font-size: calc(var(--cell) * 0.46);
		line-height: 1;
		border: 1px solid rgba(15, 23, 42, 0.35);
		box-shadow: inset 0 -0.35rem 0.5rem rgba(15, 23, 42, 0.18);
		will-change: transform;
	}

	/* Winning cell frame — an overlay, so it is unaffected by the strip's blur
	   and lines up with the window rather than with whatever panel is passing. */
	.mm-lit {
		position: absolute;
		left: var(--pad);
		right: var(--pad);
		top: calc(var(--cell) * var(--row) + var(--pad));
		height: calc(var(--cell) - var(--pad) * 2);
		border-radius: 0.5rem;
		border: 2px solid #fcd34d;
		box-shadow:
			0 0 0.9rem rgba(252, 211, 77, 0.75),
			inset 0 0 0.9rem rgba(252, 211, 77, 0.45);
		animation: mm-pulse 1s ease-in-out infinite;
		pointer-events: none;
	}

	.mm-post {
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(var(--at) * 100%);
		width: 3px;
		translate: -50% 0;
		background: linear-gradient(
			to bottom,
			rgba(240, 180, 41, 0.15),
			rgba(240, 180, 41, 0.75),
			rgba(240, 180, 41, 0.15)
		);
		pointer-events: none;
	}

	.mm-lines {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		opacity: 0.85;
		pointer-events: none;
	}

	@keyframes mm-pulse {
		50% {
			opacity: 0.45;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.mm-lit {
			animation: none;
		}
	}
</style>
