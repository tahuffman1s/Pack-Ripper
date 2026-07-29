<script>
	import { invalidateAll } from '$app/navigation';
	import PackOpener from '$lib/components/PackOpener.svelte';
	import MassOpener from '$lib/components/MassOpener.svelte';
	import { formatGold } from '$lib/economy.js';

	let { data } = $props();

	let active = $state(null); // the group being opened one pack at a time
	let bulk = $state(null); // the group being mass-ripped
	let toast = $state(null);
	let selling = $state(null); // key currently selling
	let toastTimer;

	const accentText = {
		primary: 'text-primary', secondary: 'text-secondary', info: 'text-info',
		accent: 'text-accent', success: 'text-success'
	};
	const accentBorder = {
		primary: 'hover:border-primary/50', secondary: 'hover:border-secondary/50',
		info: 'hover:border-info/50', accent: 'hover:border-accent/50', success: 'hover:border-success/50'
	};

	function openGroup(g) {
		active = g;
	}
	function massOpen(g) {
		bulk = g;
	}
	async function close() {
		active = null;
		bulk = null;
		await invalidateAll();
	}
	async function refreshCounts() {
		await invalidateAll();
	}

	function showToast(msg, ok = true) {
		toast = { msg, ok };
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 3000);
	}

	async function sellPacks(g, qty) {
		if (selling) return;
		selling = g.key;
		try {
			const res = await fetch('/api/sell-pack', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ setCode: g.setCode, packTypeId: g.packTypeId, qty })
			});
			if (!res.ok) throw new Error('sell failed');
			const r = await res.json();
			showToast(`Sold ${r.sold} ${g.packName}${r.sold === 1 ? '' : 's'} for 🪙 ${formatGold(r.earned)}`);
			await invalidateAll();
		} catch {
			showToast('Could not sell those packs.', false);
		} finally {
			selling = null;
		}
	}
</script>

<svelte:head><title>Packs · PackRipper</title></svelte:head>

<div class="mb-5">
	<h1 class="text-2xl font-black">Your Vault</h1>
	<p class="text-base-content/60 text-sm">Unopened sealed product. Tap to rip — or sell back at value.</p>
</div>

{#if data.groups.length === 0}
	<div class="card bg-base-100/60 border border-white/5 mt-8">
		<div class="card-body items-center text-center gap-3 py-10">
			<div class="text-5xl">📦</div>
			<h2 class="font-bold text-lg">Your vault is empty</h2>
			<p class="text-base-content/60 text-sm max-w-xs">Head to the store and buy some packs with your gold — you've got plenty to start.</p>
			<a href="/store" class="btn btn-primary mt-2">Go to Store</a>
		</div>
	</div>
{:else}
	<div class="grid grid-cols-2 gap-3">
		{#each data.groups as g (g.key)}
			<div class="relative card bg-base-100/70 border border-white/10 {accentBorder[g.accent]} transition-colors shadow-lg overflow-hidden">
				<button onclick={() => openGroup(g)} class="text-left active:scale-[0.98] transition-transform">
					<div class="card-body p-4 pb-2 gap-1">
						<div class="flex items-start justify-between">
							<span class="text-3xl">📦</span>
							<span class="badge badge-neutral font-bold">×{g.count}</span>
						</div>
						<div class="font-bold leading-tight mt-1 truncate">{g.setName}</div>
						<div class="text-xs {accentText[g.accent]} font-semibold">{g.packName}</div>
						<div class="mt-1 text-xs text-base-content/50 flex items-center gap-1">⚡ Tap to rip</div>
					</div>
				</button>
				{#if g.count > 1}
					<button
						class="mx-3 btn btn-xs btn-outline w-[calc(100%-1.5rem)] gap-1 {accentText[g.accent]}"
						onclick={() => massOpen(g)}
					>
						⚡⚡ Rip all {g.count}
					</button>
				{/if}
				<!-- sell-back controls -->
				<div class="px-3 pb-3 pt-1 flex items-center gap-1.5 border-t border-white/5 mt-1">
					<button
						class="btn btn-xs btn-ghost flex-1 gap-1 text-base-content/70"
						onclick={() => sellPacks(g, 1)}
						disabled={selling === g.key}
					>
						{#if selling === g.key}<span class="loading loading-spinner loading-xs"></span>{:else}Sell 1 · 🪙{formatGold(g.sellGold)}{/if}
					</button>
					{#if g.count > 1}
						<button class="btn btn-xs btn-ghost" title="Sell all" onclick={() => sellPacks(g, g.count)} disabled={selling === g.key}>all</button>
					{/if}
				</div>
			</div>
		{/each}
	</div>
{/if}

{#if data.recent.length}
	<div class="mt-8">
		<h2 class="text-sm font-bold text-base-content/60 uppercase tracking-wide mb-2">Recent rips</h2>
		<div class="flex flex-col gap-1.5">
			{#each data.recent as r (r.id)}
				<div class="flex items-center justify-between text-sm bg-base-100/50 rounded-lg px-3 py-2">
					<span class="truncate">{r.setName}</span>
					<span class="text-accent font-semibold whitespace-nowrap">🪙 {formatGold(r.valueGold)}</span>
				</div>
			{/each}
		</div>
	</div>
{/if}

{#if active}
	<PackOpener group={active} onclose={close} onopened={refreshCounts} />
{/if}

{#if bulk}
	<MassOpener group={bulk} max={data.massOpenMax} onclose={close} onopened={refreshCounts} />
{/if}

{#if toast}
	<div class="toast toast-top toast-center z-50 mt-16 px-4 w-full max-w-md">
		<div class="alert {toast.ok ? 'alert-success' : 'alert-error'} shadow-lg text-sm"><span>{toast.msg}</span></div>
	</div>
{/if}
