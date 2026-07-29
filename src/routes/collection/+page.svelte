<script>
	import { invalidateAll } from '$app/navigation';
	import CardTile from '$lib/components/CardTile.svelte';
	import { rarityInfo, cardImage, marketGold, sellGold } from '$lib/cards.js';
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

	// selection tracked as a plain array of card uids
	let selectedUids = $state([]);
	function toggle(uid) {
		if (selectedUids.includes(uid)) selectedUids = selectedUids.filter((x) => x !== uid);
		else selectedUids = [...selectedUids, uid];
	}

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

	const selectedValue = $derived(
		data.cards.filter((c) => selectedUids.includes(c.uid)).reduce((a, c) => a + sellGold(c), 0)
	);

	function showToast(msg, ok = true) {
		toast = { msg, ok };
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 3000);
	}

	function cardClick(card) {
		if (selectMode) toggle(card.uid);
		else detail = card;
	}

	function selectAllFiltered() {
		selectedUids = [...new Set([...selectedUids, ...filtered.map((c) => c.uid)])];
	}
	function clearSel() {
		selectedUids = [];
	}

	// (removed unused shim)
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
			selectedUids = [];
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
		<h1 class="text-2xl font-black">Collection</h1>
		<p class="text-base-content/60 text-sm">{data.cards.length} cards · worth 🪙 {formatGold(data.value)}</p>
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
	<div class="flex gap-2 overflow-x-auto no-scrollbar pb-2 mb-2 -mx-1 px-1">
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

	<div class="grid grid-cols-3 sm:grid-cols-4 gap-2 pb-2">
		{#each filtered as card (card.uid)}
			<CardTile
				{card}
				selectable={selectMode}
				selected={selectedUids.includes(card.uid)}
				onclick={() => cardClick(card)}
			/>
		{/each}
	</div>
{/if}

<!-- selection action bar -->
{#if selectMode && selectedUids.length}
	<div class="fixed inset-x-0 bottom-0 z-40 p-3 pb-safe">
		<div class="mx-auto max-w-2xl card bg-base-100 border border-primary/40 shadow-2xl">
			<div class="card-body p-3 flex-row items-center gap-3">
				<div class="flex-1 min-w-0">
					<div class="font-bold">{selectedUids.length} selected</div>
					<div class="text-sm text-accent">Sell for 🪙 {formatGold(selectedValue)}</div>
				</div>
				<button class="btn btn-ghost btn-sm" onclick={selectAllFiltered}>All</button>
				<button class="btn btn-primary btn-sm" onclick={() => sell(selectedUids)} disabled={selling}>
					{#if selling}<span class="loading loading-spinner loading-xs"></span>{/if}
					Sell
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- card detail modal -->
{#if detail}
	{@const r = rarityInfo(detail.rarity)}
	<div class="modal modal-open" role="dialog" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) detail = null; }} onkeydown={(e)=> e.key==='Escape' && (detail=null)}>
		<div class="modal-box max-w-sm">
			<div class="flex gap-4">
				<div class="w-32 shrink-0 aspect-[5/7] rounded-xl overflow-hidden {detail.foil ? 'foil-shimmer' : ''} {r.ring}">
					{#if cardImage(detail)}
						<img src={cardImage(detail, 'normal')} alt={detail.name} class="w-full h-full object-cover" />
					{/if}
				</div>
				<div class="min-w-0 flex-1">
					<h3 class="font-bold leading-tight">{detail.name}</h3>
					<div class="mt-1 flex flex-wrap gap-1">
						<span class="badge badge-sm {r.badge}">{r.label}</span>
						{#if detail.foil}<span class="badge badge-sm bg-gradient-to-r from-cyan-400 to-fuchsia-400 text-black border-0">Foil</span>{/if}
					</div>
					<div class="text-xs text-base-content/50 mt-1">{detail.setName || detail.set?.toUpperCase()} · #{detail.number}</div>
					<div class="mt-3 text-sm">Market: <span class="text-accent font-bold">🪙 {formatGold(marketGold(detail))}</span></div>
					<div class="text-sm">Sells for: <span class="font-bold">🪙 {formatGold(sellGold(detail))}</span></div>
					{#if detail.scryfallUri}
						<a href={detail.scryfallUri} target="_blank" rel="noopener" class="link link-primary text-xs mt-1 inline-block">View on Scryfall ↗</a>
					{/if}
				</div>
			</div>
			<div class="modal-action mt-4">
				<button class="btn btn-ghost btn-sm" onclick={() => (detail = null)}>Close</button>
				<button class="btn btn-primary btn-sm" onclick={() => sell([detail.uid])} disabled={selling}>
					Sell for 🪙 {formatGold(sellGold(detail))}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if toast}
	<div class="toast toast-top toast-center z-50 mt-16 px-4 w-full max-w-md">
		<div class="alert {toast.ok ? 'alert-success' : 'alert-error'} shadow-lg text-sm"><span>{toast.msg}</span></div>
	</div>
{/if}
