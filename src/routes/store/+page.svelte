<script>
	import { formatGold, formatUsd } from '$lib/economy.js';
	let { data } = $props();

	let q = $state('');

	const accentFor = {
		Draft: 'badge-primary', Play: 'badge-info', Set: 'badge-secondary',
		Collector: 'badge-accent', Jumpstart: 'badge-success'
	};

	// filter + group by year (newest first)
	const groups = $derived.by(() => {
		const term = q.trim().toLowerCase();
		const list = term
			? data.sets.filter((s) => s.name.toLowerCase().includes(term) || s.code.includes(term))
			: data.sets;
		const byYear = new Map();
		for (const s of list) {
			const y = s.year || 0;
			if (!byYear.has(y)) byYear.set(y, []);
			byYear.get(y).push(s);
		}
		return [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([year, sets]) => ({ year, sets }));
	});

	const shown = $derived(groups.reduce((n, g) => n + g.sets.length, 0));
</script>

<svelte:head><title>Store · PackRipper</title></svelte:head>

<div class="mb-3">
	<h1 class="text-2xl font-black">Store</h1>
	<p class="text-base-content/60 text-sm">{data.count} sets from 1993 to today · live <span class="text-success font-semibold">TCGplayer</span> market prices.</p>
</div>

<label class="input input-bordered flex items-center gap-2 mb-4 sticky top-16 z-20 bg-base-100/90 backdrop-blur">
	<svg class="size-4 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4" stroke-linecap="round"/></svg>
	<input bind:value={q} type="search" class="grow" placeholder="Search {data.count} sets…" />
	{#if q}<button class="text-xs text-base-content/50" onclick={() => (q = '')}>clear</button>{/if}
</label>

{#if shown === 0}
	<p class="text-center text-base-content/50 py-10">No sets match “{q}”.</p>
{/if}

{#each groups as group (group.year)}
	<div class="mb-5">
		<div class="flex items-center gap-2 mb-2">
			<h2 class="text-sm font-black text-base-content/70">{group.year || '—'}</h2>
			<div class="h-px flex-1 bg-white/5"></div>
			<span class="text-xs text-base-content/30">{group.sets.length}</span>
		</div>

		<div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
			{#each group.sets as set (set.code)}
				<a
					href="/store/{set.code}"
					class="group card bg-base-100/70 border border-white/5 hover:border-primary/40 transition-all active:scale-[0.98] shadow-md {set.unreleased ? 'opacity-55' : ''}"
				>
					<div class="card-body p-3 flex-row items-center gap-3">
						{#if set.icon}
							<img src={set.icon} alt="" class="size-9 shrink-0 opacity-90 {set.unreleased ? 'grayscale' : ''}" style="filter: invert(1)" loading="lazy" />
						{:else}
							<div class="size-9 shrink-0 rounded bg-base-300"></div>
						{/if}
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<h3 class="font-bold text-sm truncate">{set.name}</h3>
								{#if set.featured && !set.unreleased}<span class="text-accent text-xs">★</span>{/if}
							</div>
							<div class="flex flex-wrap gap-1 mt-1">
								{#each set.packLabels as label}
									<span class="badge badge-xs {accentFor[label] || 'badge-ghost'} badge-outline">{label}</span>
								{/each}
							</div>
						</div>
						<div class="text-right shrink-0">
							<div class="text-[0.6rem] text-base-content/40 uppercase">{set.code}</div>
							{#if set.unreleased}
								<div class="badge badge-xs badge-warning badge-outline font-semibold">Coming soon</div>
								<div class="text-[0.6rem] text-base-content/40">{set.released}</div>
							{:else}
								<div class="font-bold text-accent text-sm whitespace-nowrap">🪙{formatGold(set.fromPrice)}</div>
								<div class="text-[0.6rem] {set.live ? 'text-success/70' : 'text-base-content/40'}">{set.live ? '' : '≈'}{formatUsd(set.fromUsd)}</div>
							{/if}
						</div>
					</div>
				</a>
			{/each}
		</div>
	</div>
{/each}
