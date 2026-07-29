<script>
	import { rarityInfo, cardImage, marketGold, topTreatment, treatmentInfo, finishLabel } from '$lib/cards.js';
	import { formatGold } from '$lib/economy.js';

	let { card, selectable = false, selected = false, onclick = null, showValue = true } = $props();

	const r = $derived(rarityInfo(card.rarity));
	const img = $derived(cardImage(card, 'normal'));
	const gold = $derived(marketGold(card));
	const treat = $derived(treatmentInfo(topTreatment(card)));
	const finish = $derived(finishLabel(card));
</script>

<button
	type="button"
	class="group relative block w-full aspect-[5/7] rounded-xl overflow-hidden bg-base-300 border transition-transform active:scale-95 {selected
		? 'border-primary ring-2 ring-primary'
		: 'border-white/10'} {card.foil ? 'foil-shimmer' : ''} {r.ring}"
	onclick={onclick}
>
	{#if img}
		<img src={img} alt={card.name} loading="lazy" class="w-full h-full object-cover" />
	{:else}
		<div class="w-full h-full grid place-items-center p-2 text-center">
			<div>
				<div class="text-xs font-bold {r.text}">{card.name}</div>
				<div class="text-[0.6rem] text-base-content/50 mt-1">{r.label}</div>
			</div>
		</div>
	{/if}

	<!-- top badges -->
	<div class="absolute top-1 left-1 flex flex-col gap-1 items-start">
		{#if card.serial}
			<span class="badge badge-xs bg-gradient-to-r from-amber-300 via-fuchsia-400 to-cyan-300 text-black border-0 font-black">
				#{card.serial}/{card.serialOf}
			</span>
		{/if}
		{#if finish}
			<span class="badge badge-xs bg-gradient-to-r from-cyan-400 to-fuchsia-400 text-black border-0 font-bold">{finish}</span>
		{/if}
		{#if treat}
			<span class="badge badge-xs border-0 font-bold {treat.cls}">{treat.label}</span>
		{/if}
		{#if card.rarity === 'mythic' || card.rarity === 'rare'}
			<span class="badge badge-xs {r.badge} font-semibold">{r.label}</span>
		{/if}
	</div>

	{#if showValue}
		<div class="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/85 to-transparent px-1.5 pt-4 pb-1.5">
			<div class="flex items-center justify-between gap-1">
				<span class="text-[0.62rem] font-medium truncate text-white/90">{card.name}</span>
				<span class="text-[0.68rem] font-bold text-accent whitespace-nowrap">🪙{formatGold(gold)}</span>
			</div>
		</div>
	{/if}

	{#if selectable && selected}
		<div class="absolute top-1 right-1 size-5 rounded-full bg-primary grid place-items-center">
			<svg class="size-3 text-primary-content" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5 9-11" stroke-linecap="round" stroke-linejoin="round"/></svg>
		</div>
	{/if}
</button>
