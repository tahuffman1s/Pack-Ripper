<script>
	import { rarityInfo, cardImage, marketGold, topTreatment, treatmentInfo, finishLabel } from '$lib/cards.js';
	import { formatGold } from '$lib/economy.js';
	import { PACK_TYPES } from '$lib/packs.js';

	let { group, max = 0, onclose = () => {}, onopened = () => {} } = $props();

	const cardCount = $derived(PACK_TYPES[group?.packTypeId]?.cardCount ?? 15);
	const owned = $derived(group?.count ?? 0);
	const available = $derived(max > 0 ? Math.min(owned, max) : owned);

	let qty = $state(0);
	let phase = $state('choose'); // choose | ripping | summary
	let error = $state(null);
	let result = $state(null);
	// Showing 700 card images at once janks the scroll; reveal the long tail on ask.
	let showAll = $state(false);

	$effect(() => {
		if (!qty) qty = available;
	});

	// Preset stack sizes that make sense for the stack you actually own.
	const presets = $derived.by(() => {
		const opts = [10, 24, 30, 36, available].filter((n, i, a) => n <= available && a.indexOf(n) === i);
		return opts.sort((a, b) => a - b);
	});

	const cards = $derived(result?.cards ?? []);
	const sorted = $derived([...cards].sort((a, b) => marketGold(b) - marketGold(a)));
	const hits = $derived(sorted.filter((c) => c.rarity === 'rare' || c.rarity === 'mythic'));

	const tally = $derived.by(() => ({
		mythics: cards.filter((c) => c.rarity === 'mythic').length,
		rares: cards.filter((c) => c.rarity === 'rare').length,
		foils: cards.filter((c) => c.foil).length,
		treatments: cards.filter((c) => c.treatments?.length).length,
		serialized: cards.filter((c) => c.serial != null).length
	}));

	async function rip() {
		if (phase === 'ripping' || !qty) return;
		phase = 'ripping';
		error = null;
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
			result = await res.json();
			phase = 'summary';
			onopened();
		} catch (e) {
			error = String(e.message || e).replace(/^\{.*"message":"?/, '').replace(/"?\}$/, '');
			phase = 'choose';
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
				<div>
					<div class="text-5xl font-black tabular-nums">{qty}</div>
					<div class="text-sm text-base-content/50 mt-1">
						packs · about {qty * cardCount} cards
					</div>
				</div>

				<input
					type="range"
					class="range range-primary"
					min="1"
					max={available}
					bind:value={qty}
					disabled={phase === 'ripping'}
				/>

				<div class="flex items-center justify-center gap-1.5 flex-wrap">
					{#each presets as n}
						<button
							class="btn btn-xs {qty === n ? 'btn-primary' : 'btn-ghost'}"
							onclick={() => (qty = n)}
							disabled={phase === 'ripping'}
						>
							{n === available ? `All ${n}` : n}
						</button>
					{/each}
				</div>

				{#if max && group.count > max}
					<div class="text-[0.7rem] text-base-content/40">
						Capped at {max} packs per rip — you own {group.count}.
					</div>
				{/if}
				{#if error}
					<div class="alert alert-error text-sm py-2">{error}</div>
				{/if}
			</div>
		</div>

		<div class="shrink-0 p-5 space-y-2">
			<button class="btn btn-lg btn-primary w-full text-lg font-black" onclick={rip} disabled={phase === 'ripping'}>
				{#if phase === 'ripping'}
					<span class="loading loading-spinner"></span> Ripping {qty}…
				{:else}
					⚡ RIP {qty} PACK{qty === 1 ? '' : 'S'}
				{/if}
			</button>
			<button class="btn btn-ghost btn-sm w-full" onclick={onclose} disabled={phase === 'ripping'}>Cancel</button>
		</div>
	{/if}

	<!-- SUMMARY -->
	{#if phase === 'summary' && result}
		<div class="flex-1 min-h-0 overflow-y-auto px-5 py-4 mx-auto w-full max-w-2xl">
			<div class="text-center mb-4">
				<div class="text-sm text-base-content/50 uppercase tracking-widest">
					{result.packsOpened} packs · {cards.length} cards
				</div>
				<div class="text-4xl font-black text-accent">🪙 {formatGold(result.valueGold)}</div>
			</div>

			<div class="grid grid-cols-4 gap-2 mb-4">
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-orange-400">{tally.mythics}</div>
					<div class="text-xs text-base-content/50">Mythics</div>
				</div>
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-amber-300">{tally.rares}</div>
					<div class="text-xs text-base-content/50">Rares</div>
				</div>
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-cyan-300">{tally.foils}</div>
					<div class="text-xs text-base-content/50">Foils</div>
				</div>
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-fuchsia-400">{tally.treatments}</div>
					<div class="text-xs text-base-content/50">Special</div>
				</div>
			</div>

			{#if tally.serialized}
				<div class="alert bg-gradient-to-r from-amber-300/20 via-fuchsia-400/20 to-cyan-300/20 border border-fuchsia-400/40 mb-4 py-2 text-sm">
					⭐ {tally.serialized} serialized card{tally.serialized === 1 ? '' : 's'} in there.
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
			<div class="grid grid-cols-4 sm:grid-cols-5 gap-1.5 mb-4">
				{#each (showAll ? sorted : hits.slice(0, 20)) as card (card.uid)}
					{@const r = rarityInfo(card.rarity)}
					{@const treat = treatmentInfo(topTreatment(card))}
					<div>
						<!-- badges are absolute to the image box, not the tile, so they
						     never sit on top of the price line below it -->
						<div class="relative aspect-[5/7] rounded-md overflow-hidden {card.foil ? 'foil-shimmer' : ''} {r.ring}">
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
						</div>
						<div class="text-[0.6rem] text-accent font-bold text-center mt-0.5 tabular-nums">
							🪙{formatGold(marketGold(card))}
						</div>
					</div>
				{/each}
			</div>

			{#if !showAll && cards.length > hits.length}
				<button class="btn btn-ghost btn-sm w-full" onclick={() => (showAll = true)}>
					Show all {cards.length} cards
				</button>
			{/if}
			{#if !hits.length}
				<div class="text-sm text-base-content/50 text-center py-2">No rares in that stack. Brutal.</div>
			{/if}
		</div>

		<div class="shrink-0 p-4 grid grid-cols-2 gap-2">
			<button class="btn btn-ghost" onclick={onclose}>Done</button>
			<a class="btn btn-primary" href="/collection">View collection</a>
		</div>
	{/if}
</div>
