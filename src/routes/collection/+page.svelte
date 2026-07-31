<script>
	import { invalidateAll } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import CardTile from '$lib/components/CardTile.svelte';
	import Card3D from '$lib/components/Card3D.svelte';
	import { rarityInfo, marketGold, sellGold } from '$lib/cards.js';
	import { formatGold } from '$lib/economy.js';

	let { data } = $props();

	let sort = $state('value');
	let filter = $state('all'); // all | foil | rareplus
	let setFilter = $state('');
	let selectMode = $state(false);
	let detail = $state(null);
	let toast = $state(null);
	let selling = $state(false);
	let toastTimer;

	/**
	 * Selection is a Set, not an array.
	 *
	 * Every tile asks whether it is selected, so an array made the whole grid
	 * O(n²): selecting one card in a 10,000-card collection ran 10,000 `includes`
	 * scans over a 10,000-element array. A Set answers each in constant time.
	 */
	let selected = new SvelteSet();

	/**
	 * Running total of what the selection sells for, kept up to date as it changes
	 * rather than recomputed. Deriving it re-scanned the entire collection on every
	 * tap — and "select all" made that scan quadratic on its own.
	 */
	let selectedValue = $state(0);

	function toggle(card) {
		if (selected.has(card.uid)) {
			selected.delete(card.uid);
			selectedValue -= sellGold(card);
		} else {
			selected.add(card.uid);
			selectedValue += sellGold(card);
		}
	}

	/**
	 * How many tiles the grid renders. Ten thousand card tiles is ten thousand
	 * images, badges and gradients — enough DOM to stall the page for seconds
	 * before you can touch anything, whether or not you ever scroll that far. The
	 * list is windowed instead and grows as the sentinel below it comes into view;
	 * filtering, sorting and selecting still see every card.
	 */
	const PAGE = 120;
	let shown = $state(PAGE);

	const filtered = $derived.by(() => {
		let list = data.cards;
		if (filter === 'foil') list = list.filter((c) => c.foil);
		else if (filter === 'rareplus') list = list.filter((c) => c.rarity === 'rare' || c.rarity === 'mythic');
		if (setFilter) list = list.filter((c) => c.set === setFilter);

		const arr = [...list];
		if (sort === 'value') arr.sort((a, b) => marketGold(b) - marketGold(a));
		else if (sort === 'newest') arr.sort((a, b) => (b.acquiredAt || 0) - (a.acquiredAt || 0));
		else if (sort === 'rarity')
			arr.sort((a, b) => rarityInfo(b.rarity).order - rarityInfo(a.rarity).order || marketGold(b) - marketGold(a));
		return arr;
	});

	// A new filter or sort order starts the window over at the top.
	const listKey = $derived(`${filter}|${setFilter}|${sort}`);
	let lastKey = 'all||value';
	$effect(() => {
		if (listKey !== lastKey) {
			lastKey = listKey;
			shown = PAGE;
		}
	});

	const visible = $derived(filtered.length > shown ? filtered.slice(0, shown) : filtered);

	/** Grow the window when the sentinel after the last rendered tile is reached. */
	function moreOnView(node) {
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) shown += PAGE;
			},
			{ rootMargin: '600px' }
		);
		io.observe(node);
		return { destroy: () => io.disconnect() };
	}

	function showToast(msg, ok = true) {
		toast = { msg, ok };
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 3000);
	}

	function cardClick(card) {
		if (selectMode) toggle(card);
		else detail = card;
	}

	/** Select every card the current filters admit — not just the rendered window. */
	function selectAllFiltered() {
		let added = 0;
		for (const c of filtered) {
			if (selected.has(c.uid)) continue;
			selected.add(c.uid);
			added += sellGold(c);
		}
		selectedValue += added;
	}
	function clearSel() {
		selected.clear();
		selectedValue = 0;
	}

	async function sell(uids) {
		if (!uids.length || selling) return;
		selling = true;
		try {
			const res = await fetch('/api/sell', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ uids })
			});
			if (!res.ok) throw new Error('Sale failed');
			const r = await res.json();
			showToast(`Sold ${r.sold} card${r.sold === 1 ? '' : 's'} for 🪙 ${formatGold(r.earned)}`);
			clearSel();
			detail = null;
			await invalidateAll();
		} catch (e) {
			showToast('Could not complete the sale.', false);
		} finally {
			selling = false;
		}
	}
</script>

<svelte:head><title>Collection · PackRipper</title></svelte:head>

<div class="flex items-end justify-between mb-3">
	<div>
		<h1 class="text-2xl lg:text-3xl font-black">Collection</h1>
		<p class="text-base-content/60 text-sm">
			{data.cards.length.toLocaleString()} cards · worth 🪙 {formatGold(data.value)}
		</p>
	</div>
	{#if data.cards.length}
		<button class="btn btn-sm {selectMode ? 'btn-primary' : 'btn-ghost'}" onclick={() => { selectMode = !selectMode; if (!selectMode) clearSel(); }}>
			{selectMode ? 'Done' : 'Select'}
		</button>
	{/if}
</div>

{#if data.cards.length === 0}
	<div class="card bg-base-100/60 border border-white/5 mt-8">
		<div class="card-body items-center text-center gap-3 py-10">
			<div class="text-5xl">🃏</div>
			<h2 class="font-bold text-lg">No cards yet</h2>
			<p class="text-base-content/60 text-sm max-w-xs">Open some packs to start building your collection.</p>
			<a href="/packs" class="btn btn-primary mt-2">Open Packs</a>
		</div>
	</div>
{:else}
	<!-- controls -->
	<div class="flex gap-2 overflow-x-auto no-scrollbar pb-2 mb-2 -mx-1 px-1 lg:overflow-visible lg:mx-0 lg:px-0 lg:gap-3">
		<div class="join">
			<button class="join-item btn btn-xs {filter === 'all' ? 'btn-primary' : 'btn-ghost'}" onclick={() => (filter = 'all')}>All</button>
			<button class="join-item btn btn-xs {filter === 'rareplus' ? 'btn-primary' : 'btn-ghost'}" onclick={() => (filter = 'rareplus')}>Rare+</button>
			<button class="join-item btn btn-xs {filter === 'foil' ? 'btn-primary' : 'btn-ghost'}" onclick={() => (filter = 'foil')}>Foil</button>
		</div>
		<select class="select select-xs select-bordered w-auto" bind:value={sort}>
			<option value="value">Value ↓</option>
			<option value="rarity">Rarity ↓</option>
			<option value="newest">Newest</option>
		</select>
		<select class="select select-xs select-bordered w-auto" bind:value={setFilter}>
			<option value="">All sets</option>
			{#each data.sets as s}
				<option value={s.code}>{s.name}</option>
			{/each}
		</select>
	</div>

	{#if filtered.length !== data.cards.length}
		<p class="text-xs text-base-content/50 mb-2">{filtered.length.toLocaleString()} matching</p>
	{/if}

	<div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9 gap-2 lg:gap-3 pb-2">
		{#each visible as card (card.uid)}
			<CardTile
				{card}
				selectable={selectMode}
				selected={selected.has(card.uid)}
				onclick={() => cardClick(card)}
			/>
		{/each}
	</div>

	{#if filtered.length > visible.length}
		<div use:moreOnView class="py-6 grid place-items-center text-xs text-base-content/40">
			<span class="loading loading-dots loading-sm"></span>
			<span class="mt-1">{(filtered.length - visible.length).toLocaleString()} more</span>
		</div>
	{/if}

	<!-- room for the selection bar, which floats over the bottom of the grid -->
	{#if selectMode}<div class="h-24"></div>{/if}
{/if}

<!-- selection action bar -->
{#if selectMode}
	<!-- The bar spans the page, not the viewport: on desktop it has to clear the rail. -->
	<div class="fixed inset-x-0 bottom-0 z-40 p-3 pb-safe lg:pb-3 lg:pl-60 xl:pl-64">
		<div class="mx-auto max-w-2xl lg:max-w-3xl card bg-base-100 border border-primary/40 shadow-2xl">
			<div class="card-body p-3 flex-row items-center gap-2">
				<div class="flex-1 min-w-0">
					<div class="font-bold">{selected.size.toLocaleString()} selected</div>
					<div class="text-sm text-accent">Sell for 🪙 {formatGold(selectedValue)}</div>
				</div>
				<button class="btn btn-ghost btn-sm" onclick={selectAllFiltered}>
					All {filtered.length !== data.cards.length ? `(${filtered.length.toLocaleString()})` : ''}
				</button>
				{#if selected.size}
					<button class="btn btn-ghost btn-sm" onclick={clearSel}>None</button>
					<button class="btn btn-primary btn-sm" onclick={() => sell([...selected])} disabled={selling}>
						{#if selling}<span class="loading loading-spinner loading-xs"></span>{/if}
						Sell
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Card detail. Tapping a tile hands the card to the 3D viewer, which is where the
     picture, both faces and the sell button live. -->
{#if detail}
	<Card3D card={detail} onclose={() => (detail = null)} actions={sellAction} />
{/if}

{#snippet sellAction(card)}
	<button class="btn btn-primary btn-sm font-bold" onclick={() => sell([card.uid])} disabled={selling}>
		{#if selling}<span class="loading loading-spinner loading-xs"></span>{/if}
		Sell · 🪙{formatGold(sellGold(card))}
	</button>
{/snippet}

{#if toast}
	<div class="toast toast-top toast-center z-50 mt-16 px-4 w-full max-w-md">
		<div class="alert {toast.ok ? 'alert-success' : 'alert-error'} shadow-lg text-sm"><span>{toast.msg}</span></div>
	</div>
{/if}
