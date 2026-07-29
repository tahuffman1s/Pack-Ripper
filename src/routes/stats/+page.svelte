<script>
	import { page } from '$app/stores';
	import { formatGold } from '$lib/economy.js';
	import { rarityInfo } from '$lib/cards.js';

	let { data } = $props();
	const s = $derived(data.stats);
	const net = $derived((s.goldEarned || 0) - (s.goldSpent || 0));
	const user = $derived($page.data.user);
</script>

<svelte:head><title>Stats · PackRipper</title></svelte:head>

<div class="flex items-center justify-between mb-4">
	<div>
		<h1 class="text-2xl font-black">Stats</h1>
		<p class="text-base-content/60 text-sm">Signed in as <span class="font-semibold">{user?.username}</span></p>
	</div>
	<form method="POST" action="/logout">
		<button class="btn btn-ghost btn-sm text-error">Log out</button>
	</form>
</div>

<!-- headline wallet + net -->
<div class="grid grid-cols-2 gap-3 mb-3">
	<div class="card bg-gradient-to-br from-accent/20 to-base-100 border border-accent/20">
		<div class="card-body p-4">
			<div class="text-xs text-base-content/50 uppercase tracking-wide">Gold balance</div>
			<div class="text-2xl font-black text-accent">🪙 {formatGold(data.wallet.gold)}</div>
		</div>
	</div>
	<div class="card bg-base-100/70 border border-white/5">
		<div class="card-body p-4">
			<div class="text-xs text-base-content/50 uppercase tracking-wide">Net profit</div>
			<div class="text-2xl font-black {net >= 0 ? 'text-success' : 'text-error'}">
				{net >= 0 ? '+' : '−'}🪙 {formatGold(Math.abs(net))}
			</div>
		</div>
	</div>
</div>

<!-- collection value banner -->
<div class="card bg-base-100/70 border border-white/5 mb-3">
	<div class="card-body p-4 flex-row items-center justify-between">
		<div>
			<div class="text-xs text-base-content/50 uppercase tracking-wide">Collection value</div>
			<div class="text-xl font-black text-secondary">🪙 {formatGold(data.collectionValue)}</div>
		</div>
		<div class="text-right">
			<div class="text-xs text-base-content/50 uppercase tracking-wide">Cards owned</div>
			<div class="text-xl font-black">{data.collectionCount}</div>
		</div>
	</div>
</div>

<!-- best pull -->
{#if s.bestPull}
	{@const r = rarityInfo(s.bestPull.rarity)}
	<div class="card bg-base-100/70 border border-white/5 mb-3 overflow-hidden">
		<div class="card-body p-3 flex-row items-center gap-3">
			<div class="w-14 shrink-0 aspect-[5/7] rounded-lg overflow-hidden {s.bestPull.foil ? 'foil-shimmer' : ''} {r.ring}">
				{#if s.bestPull.image}<img src={s.bestPull.image} alt="" class="w-full h-full object-cover" />{/if}
			</div>
			<div class="min-w-0">
				<div class="text-xs text-base-content/50">🏆 Best pull ever</div>
				<div class="font-bold truncate">{s.bestPull.name}</div>
				<div class="text-sm {r.text}">{r.label} · 🪙 {formatGold(s.bestPull.gold)}</div>
			</div>
		</div>
	</div>
{/if}

<!-- grid of stats -->
<div class="grid grid-cols-2 gap-2 mb-3">
	{#each [
		{ label: 'Packs opened', value: s.packsOpened, icon: '📦' },
		{ label: 'Boxes bought', value: s.boxesOpened, icon: '🗃️' },
		{ label: 'Cards opened', value: s.cardsOpened, icon: '🃏' },
		{ label: 'Cards sold', value: s.cardsSold, icon: '💱' },
		{ label: 'Mythics pulled', value: s.mythicsPulled, icon: '🔶', cls: 'text-orange-400' },
		{ label: 'Rares pulled', value: s.raresPulled, icon: '⭐', cls: 'text-amber-300' },
		{ label: 'Foils pulled', value: s.foilsPulled, icon: '✨', cls: 'text-cyan-300' },
		{ label: 'Unopened packs', value: data.inventoryCount, icon: '🎁' }
	] as stat}
		<div class="card bg-base-100/60 border border-white/5">
			<div class="card-body p-3">
				<div class="flex items-center justify-between">
					<span class="text-lg">{stat.icon}</span>
					<span class="text-2xl font-black {stat.cls || ''}">{formatGold(stat.value || 0)}</span>
				</div>
				<div class="text-xs text-base-content/50">{stat.label}</div>
			</div>
		</div>
	{/each}
</div>

<!-- money flow -->
<div class="card bg-base-100/70 border border-white/5 mb-3">
	<div class="card-body p-4 gap-2">
		<h2 class="font-bold text-sm uppercase tracking-wide text-base-content/60">Gold flow</h2>
		<div class="flex justify-between text-sm"><span>Spent in store</span><span class="text-error font-semibold">−🪙 {formatGold(s.goldSpent)}</span></div>
		<div class="flex justify-between text-sm"><span>Earned selling</span><span class="text-success font-semibold">+🪙 {formatGold(s.goldEarned)}</span></div>
		<div class="divider my-0"></div>
		<div class="flex justify-between font-bold"><span>Net</span><span class={net >= 0 ? 'text-success' : 'text-error'}>{net >= 0 ? '+' : '−'}🪙 {formatGold(Math.abs(net))}</span></div>
	</div>
</div>

{#if data.bySet.length}
	<div class="card bg-base-100/70 border border-white/5">
		<div class="card-body p-4 gap-2">
			<h2 class="font-bold text-sm uppercase tracking-wide text-base-content/60">Most opened sets</h2>
			{#each data.bySet.slice(0, 6) as row}
				<div class="flex justify-between text-sm">
					<span class="truncate">{row.name}</span>
					<span class="font-semibold text-base-content/70">{row.count} packs</span>
				</div>
			{/each}
		</div>
	</div>
{/if}
