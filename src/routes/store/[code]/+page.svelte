<script>
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import BuyTile from '$lib/components/BuyTile.svelte';
	import { PACK_TYPES } from '$lib/packs.js';

	let { data } = $props();

	let toast = $state(null);
	let toastTimer;
	let buying = $state(null); // key currently submitting

	const gold = $derived($page.data.wallet?.gold ?? 0);
	const anyLive = $derived(data.products.some((p) => p.live));

	// group products by pack type: { packTypeId, pack, box }
	const groups = $derived.by(() => {
		const map = {};
		for (const p of data.products) {
			(map[p.packTypeId] ??= { packTypeId: p.packTypeId, meta: PACK_TYPES[p.packTypeId] })[p.kind] = p;
		}
		return Object.values(map);
	});

	const accentClasses = {
		primary: { text: 'text-primary', btn: 'btn-primary', ring: 'border-primary/40' },
		secondary: { text: 'text-secondary', btn: 'btn-secondary', ring: 'border-secondary/40' },
		info: { text: 'text-info', btn: 'btn-info', ring: 'border-info/40' },
		accent: { text: 'text-accent', btn: 'btn-accent', ring: 'border-accent/40' },
		success: { text: 'text-success', btn: 'btn-success', ring: 'border-success/40' }
	};

	function showToast(msg, ok = true) {
		toast = { msg, ok };
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 3200);
	}

	/**
	 * One handler for every buy tile.
	 *
	 * The counts come from the SERVER's reply rather than from what the tile
	 * ordered, because a buy-one-get-one means those two numbers differ — and the
	 * server is the one that decided how many free units the deal was worth.
	 */
	function bought(meta) {
		return async (result, { qty }) => {
			buying = null;
			if (result.type === 'success' && result.data?.success) {
				const { added, units, freeUnits } = result.data;
				const bonus = freeUnits ? ` — ${freeUnits} free!` : '';
				if (meta.kind === 'box') {
					showToast(
						`${units === 1 ? 'Box' : `${units} boxes`} secured${bonus} · ${added.toLocaleString()} packs in your vault.`
					);
				} else {
					showToast(
						`${added.toLocaleString()} ${meta.name}${added === 1 ? '' : 's'} added to your vault${bonus}`
					);
				}
				await invalidateAll();
			} else if (result.type === 'failure') {
				showToast(result.data?.error || 'Purchase failed.', false);
			}
		};
	}
</script>

<svelte:head><title>{data.set.name} · Store</title></svelte:head>

<a href="/store" class="btn btn-ghost btn-sm gap-1 -ml-2 mb-2">
	<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
	Store
</a>

<div class="flex items-center gap-3 mb-5">
	{#if data.icon}
		<img src={data.icon} alt="" class="size-11 lg:size-14 opacity-90" style="filter: invert(1)" />
	{/if}
	<div>
		<h1 class="text-2xl lg:text-4xl font-black leading-tight">{data.set.name}</h1>
		<p class="text-sm text-base-content/55">{data.set.tag} · {data.set.year} · {data.set.cardCount} cards · <span class="uppercase">{data.set.code}</span></p>
	</div>
</div>

{#if data.set.unreleased}
	<div class="alert alert-warning mb-3 py-2 text-sm">
		<svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round"/></svg>
		<span>Not released yet — available {data.set.released}.</span>
	</div>
{:else}
	<div class="flex items-center gap-1.5 mb-3 text-xs">
		{#if anyLive}
			<span class="inline-block size-1.5 rounded-full bg-success animate-pulse"></span>
			<span class="text-success font-semibold">Live TCGplayer market prices</span>
		{:else}
			<span class="text-base-content/50">≈ Estimated prices (no live listing found)</span>
		{/if}
	</div>
{/if}

<!-- One product per row on a phone; two or three abreast where there is room. -->
<div class="flex flex-col gap-4 lg:grid lg:grid-cols-2 2xl:grid-cols-3 lg:gap-5 lg:items-start">
	{#each groups as g (g.packTypeId)}
		{@const ac = accentClasses[g.meta.accent] || accentClasses.primary}
		<div class="card bg-base-100/70 border border-white/5 shadow-lg overflow-hidden">
			<div class="card-body p-4 gap-3">
				<div class="flex items-center justify-between">
					<h2 class="text-lg font-bold {ac.text}">{g.meta.name}</h2>
					<span class="badge badge-ghost badge-sm">{g.meta.cardCount} cards</span>
				</div>
				<p class="text-sm text-base-content/60 -mt-1">{g.meta.blurb}</p>

				<div class="grid grid-cols-2 gap-2 mt-1">
					{#if g.pack}
						<BuyTile
							product={g.pack}
							setCode={data.set.code}
							label="Pack"
							accentBtn={ac.btn}
							{gold}
							maxBuyPacks={data.maxBuyPacks}
							disabled={data.set.unreleased}
							busy={buying === g.packTypeId + ':pack'}
							onsubmit={() => (buying = g.packTypeId + ':pack')}
							onresult={bought({ kind: 'pack', name: g.meta.name })}
						/>
					{/if}

					{#if g.box}
						<BuyTile
							product={g.box}
							setCode={data.set.code}
							label="Box · {g.box.boxSize} packs"
							accentBtn={ac.btn}
							outline
							{gold}
							maxBuyPacks={data.maxBuyPacks}
							disabled={data.set.unreleased}
							busy={buying === g.packTypeId + ':box'}
							onsubmit={() => (buying = g.packTypeId + ':box')}
							onresult={bought({ kind: 'box', name: g.meta.name })}
						/>
					{/if}
				</div>
			</div>
		</div>
	{/each}
</div>

<div class="mt-6 text-center">
	<a href="/packs" class="btn btn-primary btn-wide gap-2">
		Go rip packs
		<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
	</a>
</div>

{#if toast}
	<div class="toast toast-top toast-center z-50 mt-16 px-4 w-full max-w-md">
		<div class="alert {toast.ok ? 'alert-success' : 'alert-error'} shadow-lg text-sm">
			<span>{toast.msg}</span>
		</div>
	</div>
{/if}
