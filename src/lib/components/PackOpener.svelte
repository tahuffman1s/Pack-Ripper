<script>
	import { tick, onMount } from 'svelte';
	import Pack3D from './Pack3D.svelte';
	import {
		rarityInfo,
		cardImage,
		marketGold,
		ACCENT_HEX,
		topTreatment,
		treatmentInfo,
		finishLabel
	} from '$lib/cards.js';
	import { formatGold } from '$lib/economy.js';
	import { PACK_TYPES } from '$lib/packs.js';

	let { group, onclose = () => {}, onopened = () => {} } = $props();

	const cardCount = $derived(PACK_TYPES[group?.packTypeId]?.cardCount ?? 15);

	// fetch the real TCGplayer pack photo (or set art) for the 3D wrapper
	let packArt = $state(null);
	onMount(async () => {
		if (!group?.setCode) return;
		try {
			const res = await fetch(`/api/pack-art/${group.setCode}?type=${group.packTypeId}`);
			if (res.ok) packArt = await res.json();
		} catch {
			/* falls back to a generated wrapper */
		}
	});

	// local queue of unopened pack ids for this set/type
	let queue = $state(group ? [...group.ids] : []);
	let phase = $state('ready'); // ready | opening | revealing | summary
	let pack3d = $state();
	let cards = $state([]);
	let error = $state(null);

	let animationDone = false;
	let dataReady = false;

	// carousel
	let scroller = $state();
	let currentIndex = $state(0);

	const color = $derived(ACCENT_HEX[group?.accent] || ACCENT_HEX.primary);

	const summary = $derived.by(() => {
		const total = cards.reduce((a, c) => a + marketGold(c), 0);
		let best = null;
		for (const c of cards) {
			const g = marketGold(c);
			if (!best || g > marketGold(best)) best = c;
		}
		return {
			total,
			best,
			// Multi-rare packs are real now (MKM: 40% of Play Boosters have 2+),
			// so rares and mythics are shown combined as well as apart.
			hits: cards.filter((c) => c.rarity === 'mythic' || c.rarity === 'rare').length,
			mythics: cards.filter((c) => c.rarity === 'mythic').length,
			foils: cards.filter((c) => c.foil).length,
			treatments: cards.filter((c) => c.treatments?.length).length,
			serialized: cards.filter((c) => c.serial != null).length,
			estimated: cards.some((c) => c.estimated)
		};
	});

	async function rip() {
		if (phase !== 'ready' || !queue.length) return;
		phase = 'opening';
		error = null;
		animationDone = false;
		dataReady = false;
		currentIndex = 0;

		pack3d?.rip();

		const id = queue[0];
		try {
			const res = await fetch('/api/open', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ inventoryId: id })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message || 'Could not open pack.');
			}
			const data = await res.json();
			cards = data.pack.cards;
			queue = queue.slice(1);
			dataReady = true;
			maybeReveal();
		} catch (e) {
			error = e.message;
			phase = 'ready';
		}
	}

	function handleRipped() {
		animationDone = true;
		maybeReveal();
	}

	async function maybeReveal() {
		if (!(animationDone && dataReady)) return;
		phase = 'revealing';
		onopened();
		await tick();
		scroller?.scrollTo({ left: 0 });
	}

	function onScroll() {
		if (!scroller) return;
		const w = scroller.clientWidth || 1;
		currentIndex = Math.round(scroller.scrollLeft / w);
	}

	function goToSummary() {
		phase = 'summary';
	}

	function openAnother() {
		cards = [];
		phase = 'ready';
	}

	function scrollToIndex(i) {
		const w = scroller?.clientWidth || 0;
		scroller?.scrollTo({ left: i * w, behavior: 'smooth' });
	}
</script>

<div class="fixed inset-0 z-50 bg-base-300/95 backdrop-blur-sm flex flex-col" style="padding-top: env(safe-area-inset-top,0px); padding-bottom: env(safe-area-inset-bottom,0px);">
	<!-- header -->
	<div class="flex items-center justify-between px-4 h-14 shrink-0">
		<div class="min-w-0">
			<div class="font-bold truncate">{group?.setName}</div>
			<div class="text-xs text-base-content/50">{group?.packName} · {queue.length} left</div>
		</div>
		<button class="btn btn-ghost btn-sm btn-circle" onclick={onclose} aria-label="Close">
			<svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
		</button>
	</div>

	<!-- READY / OPENING: the 3D pack -->
	{#if phase === 'ready' || phase === 'opening'}
		<div class="flex-1 min-h-0 relative">
			<Pack3D
				bind:this={pack3d}
				setName={group?.setName}
				packName={group?.packName}
				setCode={group?.setCode}
				{cardCount}
				art={packArt?.image}
				productPhoto={packArt?.kind === 'product'}
				{color}
				onripped={handleRipped}
			/>
		</div>
		<div class="p-5 shrink-0 space-y-3">
			{#if error}
				<div class="alert alert-error text-sm py-2">{error}</div>
			{/if}
			<button
				class="btn btn-lg btn-primary w-full text-lg font-black shadow-xl shadow-primary/30"
				onclick={rip}
				disabled={phase === 'opening' || !queue.length}
			>
				{#if phase === 'opening'}
					<span class="loading loading-spinner"></span> Ripping…
				{:else}
					⚡ RIP OPEN
				{/if}
			</button>
		</div>
	{/if}

	<!-- REVEALING: swipe through cards -->
	{#if phase === 'revealing'}
		<div
			bind:this={scroller}
			onscroll={onScroll}
			class="flex-1 min-h-0 flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
		>
			{#each cards as card, i (card.uid)}
				{@const r = rarityInfo(card.rarity)}
				{@const img = cardImage(card, 'large')}
				{@const treat = treatmentInfo(topTreatment(card))}
				{@const finish = finishLabel(card)}
				<div class="snap-center shrink-0 w-full h-full flex flex-col items-center justify-center px-6 gap-4">
					<!-- The real slot this card came out of, not its position. -->
					<div class="text-xs uppercase tracking-widest text-base-content/40">
						{card.slotLabel || `Card ${i + 1} of ${cards.length}`}
					</div>
					<div
						class="relative w-[68vw] max-w-[280px] aspect-[5/7] rounded-2xl overflow-hidden shadow-2xl {card.foil
							? 'foil-shimmer'
							: ''} {r.ring}"
					>
						{#if img}
							<img src={img} alt={card.name} class="w-full h-full object-cover" />
						{:else}
							<div class="w-full h-full grid place-items-center bg-base-100 p-4 text-center font-bold {r.text}">
								{card.name}
							</div>
						{/if}
						<div class="absolute top-2 left-2 flex flex-col gap-1 items-start">
							{#if card.serial}
								<span class="badge bg-gradient-to-r from-amber-300 via-fuchsia-400 to-cyan-300 text-black border-0 font-black">
									#{card.serial}/{card.serialOf}
								</span>
							{/if}
							{#if finish}
								<span class="badge bg-gradient-to-r from-cyan-400 to-fuchsia-400 text-black border-0 font-bold">{finish}</span>
							{/if}
							{#if treat}
								<span class="badge border-0 font-bold {treat.cls}">{treat.label}</span>
							{/if}
						</div>
					</div>
					<div class="text-center">
						<div class="font-bold text-lg leading-tight">{card.name}</div>
						<div class="flex items-center justify-center gap-2 mt-1 flex-wrap">
							<span class="badge {r.badge} badge-sm">{r.label}</span>
							{#if card.fromSet}
								<span class="badge badge-sm badge-outline">{card.fromSet}</span>
							{/if}
							<span class="text-accent font-bold">🪙 {formatGold(marketGold(card))}</span>
						</div>
					</div>
				</div>
			{/each}
		</div>

		<!-- dots + controls -->
		<div class="shrink-0 p-4 space-y-3">
			<div class="flex items-center justify-center gap-1.5 flex-wrap">
				{#each cards as _, i}
					<button
						aria-label="Go to card {i + 1}"
						class="size-1.5 rounded-full transition-all {i === currentIndex ? 'bg-primary w-4' : 'bg-base-content/25'}"
						onclick={() => scrollToIndex(i)}
					></button>
				{/each}
			</div>
			{#if currentIndex >= cards.length - 1}
				<button class="btn btn-primary w-full" onclick={goToSummary}>See results</button>
			{:else}
				<button class="btn btn-ghost w-full text-base-content/60" onclick={() => scrollToIndex(cards.length - 1)}>
					Skip to end →
				</button>
			{/if}
		</div>
	{/if}

	<!-- SUMMARY -->
	{#if phase === 'summary'}
		<div class="flex-1 min-h-0 overflow-y-auto px-5 py-4 mx-auto w-full max-w-2xl">
			<div class="text-center mb-4">
				<div class="text-sm text-base-content/50 uppercase tracking-widest">Pack value</div>
				<div class="text-4xl font-black text-accent">🪙 {formatGold(summary.total)}</div>
			</div>

			{#if summary.best}
				{@const br = rarityInfo(summary.best.rarity)}
				<div class="card bg-base-100/70 border border-white/5 mb-4">
					<div class="card-body p-3 flex-row items-center gap-3">
						<div class="w-14 shrink-0 aspect-[5/7] rounded-lg overflow-hidden {summary.best.foil ? 'foil-shimmer' : ''}">
							{#if cardImage(summary.best)}
								<img src={cardImage(summary.best, 'small')} alt="" class="w-full h-full object-cover" />
							{/if}
						</div>
						<div class="min-w-0">
							<div class="text-xs text-base-content/50">Best pull</div>
							<div class="font-bold truncate">{summary.best.name}</div>
							<div class="text-sm {br.text}">{br.label} · 🪙 {formatGold(marketGold(summary.best))}</div>
						</div>
					</div>
				</div>
			{/if}

			<div class="grid grid-cols-4 gap-2 mb-4">
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-amber-300">{summary.hits}</div>
					<div class="text-xs text-base-content/50">Rare+</div>
				</div>
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-orange-400">{summary.mythics}</div>
					<div class="text-xs text-base-content/50">Mythics</div>
				</div>
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-cyan-300">{summary.foils}</div>
					<div class="text-xs text-base-content/50">Foils</div>
				</div>
				<div class="stat bg-base-100/60 rounded-xl p-3">
					<div class="text-2xl font-black text-fuchsia-400">{summary.treatments}</div>
					<div class="text-xs text-base-content/50">Special</div>
				</div>
			</div>

			{#if summary.serialized}
				<div class="alert bg-gradient-to-r from-amber-300/20 via-fuchsia-400/20 to-cyan-300/20 border border-fuchsia-400/40 mb-4 py-2 text-sm">
					⭐ You pulled a serialized card.
				</div>
			{/if}
			{#if summary.estimated}
				<div class="text-[0.7rem] text-base-content/40 text-center mb-3">
					Estimated collation — no published sheet data for this set yet.
				</div>
			{/if}

			<!-- `small` is 146px wide; a grid cell is 2-3× that once devicePixelRatio
			     is applied, so these need `normal` to stay sharp. -->
			<div class="grid grid-cols-4 sm:grid-cols-5 gap-1.5">
				{#each [...cards].sort((a, b) => marketGold(b) - marketGold(a)) as card (card.uid)}
					{@const r = rarityInfo(card.rarity)}
					<div class="aspect-[5/7] rounded-md overflow-hidden {card.foil ? 'foil-shimmer' : ''} {r.ring}">
						{#if cardImage(card)}
							<img src={cardImage(card, 'normal')} alt={card.name} loading="lazy" class="w-full h-full object-cover" />
						{:else}
							<div class="w-full h-full grid place-items-center bg-base-100 text-[0.5rem] p-1 text-center {r.text}">{card.name}</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<div class="shrink-0 p-4 grid grid-cols-2 gap-2">
			<button class="btn btn-ghost" onclick={onclose}>Done</button>
			<button class="btn btn-primary" onclick={openAnother} disabled={!queue.length}>
				{queue.length ? `Open next (${queue.length})` : 'No more'}
			</button>
		</div>
	{/if}
</div>
