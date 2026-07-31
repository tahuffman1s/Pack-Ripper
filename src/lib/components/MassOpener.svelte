<script>
	import Card3D from './Card3D.svelte';
	import { rarityInfo, cardImage, marketGold, topTreatment, treatmentInfo, finishLabel } from '$lib/cards.js';
	import { formatGold } from '$lib/economy.js';
	import { PACK_TYPES } from '$lib/packs.js';

	/** The card being examined in the 3D viewer, or null. */
	let inspect = $state(null);

	let { group, onclose = () => {}, onopened = () => {} } = $props();

	const packType = $derived(PACK_TYPES[group?.packTypeId]);
	const cardCount = $derived(packType?.cardCount ?? 15);
	const boxSize = $derived(packType?.boxSize ?? 36);
	const available = $derived(group?.count ?? 0);

	let qty = $state(0);
	let phase = $state('choose'); // choose | ripping | summary
	let error = $state(null);
	let result = $state(null);
	// How far the rip has got. The server streams this as chunks are banked.
	let progress = $state(null);
	// Showing hundreds of card images at once janks the scroll; reveal the tail on ask.
	let showAll = $state(false);

	$effect(() => {
		if (!qty) qty = available;
	});

	// Preset stack sizes: a box and a case of this product, then everything.
	const presets = $derived.by(() => {
		const opts = [boxSize, boxSize * 6, available].filter(
			(n, i, a) => n > 0 && n <= available && a.indexOf(n) === i
		);
		return opts.sort((a, b) => a - b);
	});

	const fmt = (n) => (n ?? 0).toLocaleString();
	/** Hits shown before "show all" is asked for. */
	const shownHits = 20;
	// A rip only sends back its best pulls; the counts beside them are exact.
	const cards = $derived(result?.cards ?? []);
	const hits = $derived(cards.filter((c) => c.rarity === 'rare' || c.rarity === 'mythic'));
	const pct = $derived(progress?.total ? (progress.packsOpened / progress.total) * 100 : 0);

	function clampQty(v) {
		const n = Math.floor(Number(v));
		if (!Number.isFinite(n) || n < 1) return 1;
		return Math.min(n, available);
	}

	/**
	 * Rip, reading the NDJSON progress stream to the end.
	 *
	 * A rip of any size arrives on one connection, so failures can land either as
	 * an HTTP status (before the stream opens) or as a final `error` line (after).
	 */
	async function rip() {
		if (phase === 'ripping' || !qty) return;
		phase = 'ripping';
		error = null;
		progress = { total: qty, packsOpened: 0, cardCount: 0, valueGold: 0, mythics: 0, rares: 0 };
		try {
			const res = await fetch('/api/open-many', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ setCode: group.setCode, packTypeId: group.packTypeId, count: qty })
			});
			if (!res.ok) {
				const t = await res.text();
				throw new Error(t.slice(0, 200) || 'Mass rip failed');
			}

			let done = null;
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			for (;;) {
				const { value, done: eof } = await reader.read();
				buf += value ? decoder.decode(value, { stream: true }) : '';
				// Everything up to the last newline is complete lines; the remainder
				// is a partial line waiting for the next chunk.
				const cut = buf.lastIndexOf('\n');
				if (cut >= 0) {
					for (const line of buf.slice(0, cut).split('\n')) {
						if (!line) continue;
						const msg = JSON.parse(line);
						if (msg.type === 'progress') progress = msg;
						else if (msg.type === 'error') throw new Error(msg.error);
						else if (msg.type === 'done') done = msg;
					}
					buf = buf.slice(cut + 1);
				}
				if (eof) break;
			}
			if (!done) throw new Error('The rip was cut short.');

			result = done;
			phase = 'summary';
			onopened();
		} catch (e) {
			error = String(e.message || e).replace(/^\{.*"message":"?/, '').replace(/"?\}$/, '');
			phase = 'choose';
			// Chunks already banked are banked, so the vault has to be re-read even
			// when the rip ended badly.
			onopened();
		} finally {
			progress = null;
		}
	}
</script>

<div
	class="fixed inset-0 z-50 bg-base-300/95 backdrop-blur-sm flex flex-col"
	style="padding-top: env(safe-area-inset-top,0px); padding-bottom: env(safe-area-inset-bottom,0px);"
>
	<div class="flex items-center justify-between px-4 h-14 shrink-0">
		<div class="min-w-0">
			<div class="font-bold truncate">{group?.setName}</div>
			<div class="text-xs text-base-content/50">{group?.packName} · mass rip</div>
		</div>
		<button class="btn btn-ghost btn-sm btn-circle" onclick={onclose} aria-label="Close">
			<svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
			</svg>
		</button>
	</div>

	<!-- CHOOSE -->
	{#if phase === 'choose' || phase === 'ripping'}
		<div class="flex-1 min-h-0 overflow-y-auto px-5 grid place-items-center">
			<div class="w-full max-w-sm text-center space-y-5 py-6">
				<div class="text-6xl">📦</div>

				{#if phase === 'ripping' && progress}
					<!-- RIPPING: the server streams a count as each chunk is banked. -->
					<div>
						<div class="text-5xl font-black tabular-nums">{fmt(progress.packsOpened)}</div>
						<div class="text-sm text-base-content/50 mt-1">
							of {fmt(progress.total)} packs · {fmt(progress.cardCount)} cards
						</div>
					</div>
					<progress class="progress progress-primary w-full" value={pct} max="100"></progress>
					<div class="flex items-center justify-center gap-4 text-sm tabular-nums">
						<span class="text-accent font-bold">🪙 {formatGold(progress.valueGold)}</span>
						<span class="text-orange-400">{fmt(progress.mythics)} mythic</span>
						<span class="text-amber-300">{fmt(progress.rares)} rare</span>
					</div>
				{:else}
					<div>
						<div class="text-5xl font-black tabular-nums">{fmt(qty)}</div>
						<div class="text-sm text-base-content/50 mt-1">
							packs · about {fmt(qty * cardCount)} cards
						</div>
					</div>

					<input type="range" class="range range-primary" min="1" max={available} bind:value={qty} />

					<div class="flex items-center justify-center gap-1.5 flex-wrap">
						{#each presets as n}
							<button
								class="btn btn-xs {qty === n ? 'btn-primary' : 'btn-ghost'}"
								onclick={() => (qty = n)}
							>
								{n === available ? `All ${fmt(n)}` : n === boxSize ? `Box ${n}` : n === boxSize * 6 ? `Case ${n}` : fmt(n)}
							</button>
						{/each}
					</div>

					<!-- The slider is unusable for picking 4,317 out of 50,000, so the
					     exact number is typeable too. There is no per-rip ceiling. -->
					<label class="flex items-center justify-center gap-2 text-xs text-base-content/50">
						<span>or exactly</span>
						<input
							type="number"
							class="input input-sm input-bordered w-28 text-center tabular-nums"
							min="1"
							max={available}
							value={qty}
							oninput={(e) => (qty = clampQty(e.currentTarget.value))}
						/>
					</label>

					{#if error}
						<div class="alert alert-error text-sm py-2">{error}</div>
					{/if}
				{/if}
			</div>
		</div>

		<div class="shrink-0 p-5 space-y-2">
			<button class="btn btn-lg btn-primary w-full text-lg font-black" onclick={rip} disabled={phase === 'ripping'}>
				{#if phase === 'ripping'}
					<span class="loading loading-spinner"></span> Ripping {fmt(qty)}…
				{:else}
					⚡ RIP {fmt(qty)} PACK{qty === 1 ? '' : 'S'}
				{/if}
			</button>
			<button class="btn btn-ghost btn-sm w-full" onclick={onclose} disabled={phase === 'ripping'}>Cancel</button>
		</div>
	{/if}

	<!-- SUMMARY -->
	{#if phase === 'summary' && result}
		<div class="flex-1 min-h-0 overflow-y-auto px-5 py-4 mx-auto w-full max-w-2xl lg:max-w-5xl">
			<div class="text-center mb-4">
				<div class="text-sm text-base-content/50 uppercase tracking-widest">
					{fmt(result.packsOpened)} packs · {fmt(result.cardCount)} cards
				</div>
				<div class="text-4xl font-black text-accent">🪙 {formatGold(result.valueGold)}</div>
			</div>

			<div class="grid grid-cols-4 gap-2 mb-4">
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-orange-400">{fmt(result.mythics)}</div>
					<div class="text-xs text-base-content/50">Mythics</div>
				</div>
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-amber-300">{fmt(result.rares)}</div>
					<div class="text-xs text-base-content/50">Rares</div>
				</div>
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-cyan-300">{fmt(result.foils)}</div>
					<div class="text-xs text-base-content/50">Foils</div>
				</div>
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-fuchsia-400">{fmt(result.treatments)}</div>
					<div class="text-xs text-base-content/50">Special</div>
				</div>
			</div>

			{#if result.serialized}
				<div class="alert bg-gradient-to-r from-amber-300/20 via-fuchsia-400/20 to-cyan-300/20 border border-fuchsia-400/40 mb-4 py-2 text-sm">
					⭐ {fmt(result.serialized)} serialized card{result.serialized === 1 ? '' : 's'} in there.
				</div>
			{/if}
			{#if result.skipped}
				<div class="alert alert-warning text-sm py-2 mb-4">
					{result.skipped} pack{result.skipped === 1 ? '' : 's'} left sealed — no card data for that set yet.
				</div>
			{/if}
			{#if result.estimated}
				<div class="text-[0.7rem] text-base-content/40 text-center mb-3">
					Estimated collation — no published sheet data for this set yet.
				</div>
			{/if}

			<!-- the hits, big; everything else stays folded away -->
			<h3 class="text-sm font-bold text-base-content/60 uppercase tracking-wide mb-2">
				Top pulls
			</h3>
			<div class="grid grid-cols-4 sm:grid-cols-5 lg:grid-cols-8 xl:grid-cols-10 gap-1.5 lg:gap-2 mb-4">
				{#each (showAll ? cards : hits.slice(0, shownHits)) as card (card.uid)}
					{@const r = rarityInfo(card.rarity)}
					{@const treat = treatmentInfo(topTreatment(card))}
					<div>
						<!-- badges are absolute to the image box, not the tile, so they
						     never sit on top of the price line below it -->
						<button
							type="button"
							class="relative block w-full aspect-[5/7] rounded-md overflow-hidden transition-transform active:scale-95 {card.foil
								? 'foil-shimmer'
								: ''} {r.ring}"
							onclick={() => (inspect = card)}
							aria-label="Look at {card.name}"
						>
							{#if cardImage(card)}
								<img src={cardImage(card, 'normal')} alt={card.name} loading="lazy" class="w-full h-full object-cover" />
							{:else}
								<div class="w-full h-full grid place-items-center bg-base-100 text-[0.5rem] p-1 text-center {r.text}">
									{card.name}
								</div>
							{/if}
							{#if card.serial}
								<span class="absolute top-0.5 left-0.5 badge badge-xs bg-gradient-to-r from-amber-300 to-cyan-300 text-black border-0 font-black">
									#{card.serial}
								</span>
							{:else if treat}
								<span class="absolute bottom-0.5 left-0.5 badge badge-xs border-0 font-bold {treat.cls}">{treat.label}</span>
							{:else if finishLabel(card)}
								<span class="absolute bottom-0.5 left-0.5 badge badge-xs bg-cyan-400 text-black border-0 font-bold">
									{finishLabel(card)}
								</span>
							{/if}
						</button>
						<div class="text-[0.6rem] text-accent font-bold text-center mt-0.5 tabular-nums">
							🪙{formatGold(marketGold(card))}
						</div>
					</div>
				{/each}
			</div>

			<!-- The default view is the 20 biggest hits. The button has to key off
			     that, not off whether any non-hits came back: a big rip's whole
			     top-250 is rares, and testing for non-hits hid the rest of it. -->
			{#if !showAll && cards.length > shownHits}
				<button class="btn btn-ghost btn-sm w-full" onclick={() => (showAll = true)}>
					{result.truncated ? `Show the top ${fmt(cards.length)} cards` : `Show all ${fmt(cards.length)} cards`}
				</button>
			{/if}
			{#if result.truncated}
				<div class="text-[0.7rem] text-base-content/40 text-center mt-2">
					The {fmt(cards.length)} most valuable of {fmt(result.cardCount)} cards — every one of them
					is in your collection.
				</div>
			{/if}
			{#if !hits.length}
				<div class="text-sm text-base-content/50 text-center py-2">No rares in that stack. Brutal.</div>
			{/if}
		</div>

		<div class="shrink-0 p-4 grid grid-cols-2 gap-2 mx-auto w-full max-w-2xl">
			<button class="btn btn-ghost" onclick={onclose}>Done</button>
			<a class="btn btn-primary" href="/collection">View collection</a>
		</div>
	{/if}
</div>

<!-- Any of the rip's top pulls, big and in the hand. -->
{#if inspect}
	<Card3D card={inspect} onclose={() => (inspect = null)} />
{/if}
