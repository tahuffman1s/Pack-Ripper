<script>
	import { cardRank, cardSuit, suitInfo } from '$lib/blackjack.js';

	let { card = null, hidden = false, small = false, dim = false } = $props();

	const rank = $derived(card ? cardRank(card) : '');
	const suit = $derived(card ? suitInfo(cardSuit(card)) : null);
</script>

{#if hidden || !card}
	<!-- Face down: the hole card the server has not revealed yet. -->
	<div
		class="rounded-lg border border-white/15 bg-gradient-to-br from-violet-900 via-indigo-900 to-slate-900 grid place-items-center shadow-lg shrink-0 {small
			? 'w-9 h-[3.25rem]'
			: 'w-12 h-[4.4rem]'}"
	>
		<span class="text-lg opacity-60">⚡</span>
	</div>
{:else}
	<div
		class="relative rounded-lg border border-black/20 shadow-lg shrink-0 flex flex-col justify-between p-1 {small
			? 'w-9 h-[3.25rem]'
			: 'w-12 h-[4.4rem]'} {dim ? 'opacity-45' : ''}"
		style="background:{suit.color};color:{suit.text}"
	>
		<span class="{small ? 'text-[0.6rem]' : 'text-xs'} font-black leading-none">{rank}</span>
		<span class="{small ? 'text-sm' : 'text-lg'} leading-none self-center">{suit.glyph}</span>
		<span class="{small ? 'text-[0.6rem]' : 'text-xs'} font-black leading-none self-end rotate-180">{rank}</span>
	</div>
{/if}
