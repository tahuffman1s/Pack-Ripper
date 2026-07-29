<script>
	import { cardRank, cardSuit, suitInfo } from '$lib/blackjack.js';

	let { card = null, hidden = false, small = false, dim = false } = $props();

	const rank = $derived(card ? cardRank(card) : '');
	const suit = $derived(card ? suitInfo(cardSuit(card)) : null);
</script>

{#if hidden || !card}
	<!-- Face down: the hole card the server has not revealed yet. -->
	<div
		class="rounded-lg lg:rounded-xl border border-white/15 bg-gradient-to-br from-violet-900 via-indigo-900 to-slate-900 grid place-items-center shadow-lg shrink-0 {small
			? 'w-9 h-[3.25rem] lg:w-12 lg:h-[4.4rem]'
			: 'w-12 h-[4.4rem] lg:w-[4.75rem] lg:h-[6.9rem]'}"
	>
		<span class="text-lg lg:text-2xl opacity-60">⚡</span>
	</div>
{:else}
	<div
		class="relative rounded-lg lg:rounded-xl border border-black/20 shadow-lg shrink-0 flex flex-col justify-between p-1 lg:p-1.5 {small
			? 'w-9 h-[3.25rem] lg:w-12 lg:h-[4.4rem]'
			: 'w-12 h-[4.4rem] lg:w-[4.75rem] lg:h-[6.9rem]'} {dim ? 'opacity-45' : ''}"
		style="background:{suit.color};color:{suit.text}"
	>
		<span class="{small ? 'text-[0.6rem] lg:text-xs' : 'text-xs lg:text-lg'} font-black leading-none">{rank}</span>
		<span class="{small ? 'text-sm lg:text-lg' : 'text-lg lg:text-3xl'} leading-none self-center">{suit.glyph}</span>
		<span class="{small ? 'text-[0.6rem] lg:text-xs' : 'text-xs lg:text-lg'} font-black leading-none self-end rotate-180">{rank}</span>
	</div>
{/if}
