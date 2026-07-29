<script>
	/**
	 * One buyable product (a pack or a box) with a quantity control.
	 *
	 * "Max" is whichever binds first: what the wallet can afford, or the order's
	 * pack ceiling — a box of 36 hits the 1,080-pack limit at 30 boxes, a single
	 * pack at 1,080. The server re-derives both, so this is only ever a hint.
	 */
	import { enhance } from '$app/forms';
	import { formatGold, formatUsd } from '$lib/economy.js';

	let {
		product,
		setCode,
		label,
		accentBtn,
		outline = false,
		gold,
		maxBuyPacks,
		disabled = false,
		busy = false,
		onsubmit,
		onresult
	} = $props();

	let qty = $state(1);

	const perUnit = $derived(product.kind === 'box' ? product.boxSize || 1 : 1);
	const affordable = $derived(product.priceGold > 0 ? Math.floor(gold / product.priceGold) : 0);
	const capped = $derived(Math.floor(maxBuyPacks / perUnit));
	const max = $derived(Math.max(0, Math.min(affordable, capped)));
	const total = $derived(product.priceGold * qty);
	const packs = $derived(perUnit * qty);

	function clamp(n) {
		return Math.max(1, Math.min(Math.max(1, capped), Math.floor(Number(n) || 1)));
	}
</script>

<div class="rounded-xl border border-white/10 bg-base-200/40 p-2.5 flex flex-col gap-2">
	<div class="text-center">
		<div class="text-xs opacity-70">{label}</div>
		<div class="font-bold leading-tight">🪙 {formatGold(product.priceGold)}</div>
		<div class="text-[0.6rem] opacity-70">{product.live ? '' : '≈'}{formatUsd(product.priceUsd)} each</div>
	</div>

	<div class="join w-full">
		<button
			type="button"
			class="join-item btn btn-xs btn-ghost px-2"
			onclick={() => (qty = clamp(qty - 1))}
			disabled={disabled || qty <= 1}
			aria-label="one fewer">−</button
		>
		<input
			type="number"
			class="join-item input input-xs input-bordered w-full text-center font-bold [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
			min="1"
			max={Math.max(1, capped)}
			bind:value={qty}
			onchange={() => (qty = clamp(qty))}
			{disabled}
			aria-label="quantity"
		/>
		<button
			type="button"
			class="join-item btn btn-xs btn-ghost px-2"
			onclick={() => (qty = clamp(qty + 1))}
			disabled={disabled || qty >= capped}
			aria-label="one more">+</button
		>
	</div>

	<div class="flex gap-1">
		{#each [5, 10, 25] as n}
			{#if n <= capped}
				<button
					type="button"
					class="btn btn-xs btn-ghost flex-1 px-0 {qty === n ? 'btn-active' : ''}"
					onclick={() => (qty = n)}
					{disabled}>{n}</button
				>
			{/if}
		{/each}
		<button
			type="button"
			class="btn btn-xs btn-ghost flex-1 px-0"
			onclick={() => (qty = Math.max(1, max))}
			disabled={disabled || max < 1}
			title="As many as you can afford">Max</button
		>
	</div>

	<form
		method="POST"
		action="?/buy"
		use:enhance={() => {
			onsubmit?.();
			return async ({ result }) => onresult?.(result, { qty, packs });
		}}
	>
		<input type="hidden" name="setCode" value={setCode} />
		<input type="hidden" name="packTypeId" value={product.packTypeId} />
		<input type="hidden" name="kind" value={product.kind} />
		<input type="hidden" name="qty" value={qty} />
		<button
			class="btn btn-sm w-full {outline ? 'btn-outline' : ''} {accentBtn}"
			disabled={disabled || busy || total > gold}
		>
			{#if busy}
				<span class="loading loading-spinner loading-xs"></span>
			{:else if total > gold}
				Not enough gold
			{:else}
				Buy {qty > 1 ? qty : ''} · 🪙 {formatGold(total)}
			{/if}
		</button>
	</form>

	{#if qty > 1}
		<div class="text-[0.6rem] text-center opacity-60 -mt-1">
			{packs.toLocaleString()} pack{packs === 1 ? '' : 's'}
		</div>
	{/if}
</div>
