<script>
	import { page } from '$app/stores';
	import { formatGold } from '$lib/economy.js';

	let { data } = $props();
	const user = $derived($page.data.user);
	const net = $derived((data.stats.goldEarned || 0) - (data.stats.goldSpent || 0));
</script>

<svelte:head><title>PackRipper</title></svelte:head>

<!-- greeting -->
<div class="mb-4">
	<p class="text-base-content/60 text-sm">Welcome back,</p>
	<h1 class="text-2xl lg:text-3xl font-black">{user?.username} 👋</h1>
</div>

<!-- On desktop the wallet, the numbers and the shop sit side by side and the rip
     history moves into a rail, instead of stacking into one long narrow column. -->
<div class="lg:grid lg:grid-cols-3 lg:gap-6 lg:items-start">
	<div class="lg:col-span-2">
		<!-- hero wallet card -->
		<div class="card bg-gradient-to-br from-primary/25 via-base-100 to-secondary/20 border border-white/10 shadow-xl mb-4 overflow-hidden relative">
			<div class="card-body p-5 lg:p-6 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
				<div>
					<div class="text-xs uppercase tracking-widest text-base-content/50">Your gold</div>
					<div class="text-4xl lg:text-5xl font-black text-accent flex items-center gap-2">🪙 {formatGold(data.wallet.gold)}</div>
				</div>
				<div class="flex gap-2 mt-3 lg:mt-0 lg:shrink-0">
					<a href="/store" class="btn btn-primary btn-sm lg:btn-md flex-1 lg:flex-none">Buy packs</a>
					{#if data.inventoryCount}
						<a href="/packs" class="btn btn-secondary btn-sm lg:btn-md flex-1 lg:flex-none">Rip {data.inventoryCount} pack{data.inventoryCount === 1 ? '' : 's'}</a>
					{:else}
						<a href="/collection" class="btn btn-ghost btn-sm lg:btn-md flex-1 lg:flex-none">View cards</a>
					{/if}
				</div>
			</div>
		</div>

		<!-- quick stats -->
		<div class="grid grid-cols-3 gap-2 lg:gap-3 mb-5">
			<div class="card bg-base-100/60 border border-white/5">
				<div class="card-body p-3 lg:p-4 items-center text-center">
					<div class="text-xl lg:text-3xl font-black">{formatGold(data.stats.packsOpened)}</div>
					<div class="text-[0.65rem] lg:text-xs text-base-content/50 leading-tight">Packs opened</div>
				</div>
			</div>
			<div class="card bg-base-100/60 border border-white/5">
				<div class="card-body p-3 lg:p-4 items-center text-center">
					<div class="text-xl lg:text-3xl font-black text-secondary">🪙{formatGold(data.collectionValue)}</div>
					<div class="text-[0.65rem] lg:text-xs text-base-content/50 leading-tight">Collection value</div>
				</div>
			</div>
			<div class="card bg-base-100/60 border border-white/5">
				<div class="card-body p-3 lg:p-4 items-center text-center">
					<div class="text-xl lg:text-3xl font-black {net >= 0 ? 'text-success' : 'text-error'}">{net >= 0 ? '+' : '−'}{formatGold(Math.abs(net))}</div>
					<div class="text-[0.65rem] lg:text-xs text-base-content/50 leading-tight">Net profit</div>
				</div>
			</div>
		</div>

		<!-- featured sets -->
		<div class="flex items-center justify-between mb-2">
			<h2 class="font-bold">🔥 Hot sets</h2>
			<a href="/store" class="link link-primary text-sm">All sets →</a>
		</div>
		<!-- A swipe row on a phone; a grid once there is room for one. -->
		<div class="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 pb-2 mb-4 lg:grid lg:grid-cols-3 xl:grid-cols-4 lg:overflow-visible lg:mx-0 lg:px-0">
			{#each data.featured as set (set.code)}
				<a href="/store/{set.code}" class="shrink-0 w-40 lg:w-auto card bg-base-100/70 border border-white/5 hover:border-primary/40 transition-colors shadow-lg">
					<div class="card-body p-3 gap-1">
						<div class="badge badge-accent badge-xs font-semibold">★ {set.tag}</div>
						<div class="font-bold text-sm leading-tight mt-1">{set.name}</div>
						<div class="text-xs text-base-content/50">{set.year}</div>
						<div class="text-xs text-accent font-bold mt-1">from 🪙 {formatGold(set.fromPrice)}</div>
					</div>
				</a>
			{/each}
		</div>
	</div>

	<!-- recent activity -->
	<div class="lg:sticky lg:top-7">
		{#if data.recent.length}
			<h2 class="font-bold mb-2">Recent rips</h2>
			<div class="flex flex-col gap-1.5">
				{#each data.recent as r (r.id)}
					<div class="flex items-center justify-between text-sm bg-base-100/50 rounded-lg px-3 py-2">
						<span class="truncate">{r.setName}</span>
						<span class="text-accent font-semibold whitespace-nowrap">🪙 {formatGold(r.valueGold)}</span>
					</div>
				{/each}
			</div>
		{:else}
			<div class="card bg-base-100/50 border border-dashed border-white/10">
				<div class="card-body items-center text-center py-6 gap-1">
					<div class="text-3xl">✨</div>
					<p class="text-sm text-base-content/60">Rip your first pack to see your history here.</p>
				</div>
			</div>
		{/if}
	</div>
</div>
