<script>
	import { invalidateAll } from '$app/navigation';
	import SlotMachine3D from '$lib/components/SlotMachine3D.svelte';
	import {
		BET_LEVELS,
		LINE_OPTIONS,
		MIN_BET,
		MAX_BET,
		DEFAULT_BET,
		DEFAULT_LINES,
		PAYLINES,
		PAYTABLE,
		SCATTER,
		SYMBOLS,
		ROWS,
		maxAffordableBet,
		stepBet,
		totalBet
	} from '$lib/slots.js';
	import { formatGold } from '$lib/economy.js';

	let { data } = $props();

	let machine = $state();
	let spinning = $state(false);
	let result = $state(null);
	let error = $state(null);
	let gold = $state(data.wallet?.gold ?? 0);
	let noWebGL = $state(false);
	// A bonus round in progress dictates the stake — adopt it so the controls and
	// the banner show what is actually being played, not a stale local choice.
	let lines = $state(data.freeSpins?.lines ?? DEFAULT_LINES);
	let bet = $state(data.freeSpins?.lineBet ?? DEFAULT_BET);
	let freeLeft = $state(data.freeSpins?.remaining ?? 0);
	/** The stake the server locked in for the bonus round, authoritative while it runs. */
	let lockedStake = $state(data.freeSpins ? { lineBet: data.freeSpins.lineBet, lines: data.freeSpins.lines } : null);

	let session = $state({ spins: 0, staked: 0, won: 0, bonuses: 0 });

	const stake = $derived(totalBet(bet, lines));
	const affordable = $derived(maxAffordableBet(gold, lines));
	// A free spin costs nothing, so it is always playable.
	const canSpin = $derived(!spinning && (freeLeft > 0 || (affordable !== null && gold >= stake)));
	const sessionNet = $derived(session.won - session.staked);

	function setBet(next) {
		if (spinning || freeLeft > 0) return;
		bet = next;
	}
	function nudge(dir) {
		if (spinning || freeLeft > 0) return;
		bet = stepBet(bet, dir, gold, lines);
	}
	function setLines(n) {
		if (spinning || freeLeft > 0) return;
		lines = n;
	}
	function betMax() {
		if (spinning || freeLeft > 0) return;
		bet = affordable ?? MIN_BET;
	}

	// Drop the stake if a losing run makes it unaffordable, so the button never
	// sits disabled while there is still gold to play with.
	$effect(() => {
		if (freeLeft === 0 && affordable !== null && bet > affordable) bet = affordable;
	});

	// The outcome is held back until the reels finish, so nothing spoils the landing.
	let held = null;

	async function spin() {
		if (!canSpin) return;
		spinning = true;
		error = null;
		result = null;
		try {
			const res = await fetch('/api/spin', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ bet, lines })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message || 'Could not spin.');
			}
			held = await res.json();
			if (noWebGL) setTimeout(settle, 900);
			else machine?.spinTo(held.stops);
		} catch (e) {
			error = e.message;
			spinning = false;
		}
	}

	function settle() {
		if (!held) return;
		result = held;
		gold = held.gold;
		freeLeft = held.freeSpinsLeft;
		// The server tells us what it actually staked; mirror it so the banner
		// and controls can never drift from the real bonus-round stake.
		lockedStake = freeLeft > 0 ? { lineBet: held.lineBet, lines: held.lines } : null;
		if (freeLeft > 0) {
			bet = held.lineBet;
			lines = held.lines;
		}
		session.spins += 1;
		session.staked += held.cost;
		session.won += held.win;
		if (held.awardedFreeSpins) session.bonuses += 1;
		held = null;
		spinning = false;
		invalidateAll();
	}

	/** Cells that are part of a winning line, for the result grid. */
	const litCells = $derived.by(() => {
		const lit = new Set();
		for (const lw of result?.lineWins ?? []) {
			lw.rows.forEach((row, reel) => lit.add(`${reel}:${row}`));
		}
		for (const [reel, row] of result?.scatterCells ?? []) {
			if (result?.scatterHit) lit.add(`${reel}:${row}`);
		}
		return lit;
	});

	const payRows = [
		{ key: 'wild3', icons: ['wild', 'wild', 'wild'] },
		{ key: 'mythic3', icons: ['mythic', 'mythic', 'mythic'] },
		{ key: 'foil3', icons: ['foil', 'foil', 'foil'] },
		{ key: 'mana3', icons: ['r', 'r', 'r'] },
		{ key: 'rainbow3', icons: ['w', 'u', 'g'] },
		{ key: 'mythic2', icons: ['mythic', 'mythic'] },
		{ key: 'foil2', icons: ['foil', 'foil'] }
	];
</script>

<svelte:head><title>Mana Machine · PackRipper</title></svelte:head>

<div class="space-y-4 pb-24">
	<div>
		<h1 class="text-2xl font-black tracking-tight">Mana Machine</h1>
		<p class="text-sm text-base-content/50">
			3 reels × 3 rows, {PAYLINES.length} paylines, free spins.
		</p>
	</div>

	{#if freeLeft > 0}
		<div class="rounded-2xl border border-fuchsia-400/50 bg-gradient-to-r from-fuchsia-500/20 to-cyan-400/20 px-4 py-3 flex items-center justify-between gap-3">
			<div>
				<div class="font-black tracking-wide">FREE SPINS</div>
				<div class="text-xs text-base-content/60">
					{lockedStake?.lines ?? lines}
					{(lockedStake?.lines ?? lines) === 1 ? 'line' : 'lines'} at 🪙{formatGold(lockedStake?.lineBet ?? bet)} — locked in, costs nothing
				</div>
			</div>
			<div class="text-3xl font-black tabular-nums text-fuchsia-300">{freeLeft}</div>
		</div>
	{/if}

	<!-- The machine -->
	<div class="relative rounded-2xl overflow-hidden bg-gradient-to-b from-base-100 to-base-300 border border-white/10 shadow-2xl">
		<div class="h-[42vh] min-h-[260px] max-h-[380px]">
			<SlotMachine3D bind:this={machine} onlanded={settle} onnowebgl={() => (noWebGL = true)} />
		</div>

		{#if result}
			<div class="absolute inset-x-0 bottom-0 p-3">
				{#if result.win > 0}
					<div
						class="rounded-xl px-4 py-2.5 text-center font-black shadow-xl bg-gradient-to-r from-amber-300 via-fuchsia-400 to-cyan-300 text-black"
						class:animate-bounce={result.win >= result.stake * 20}
					>
						<div class="text-[0.65rem] uppercase tracking-widest opacity-80">
							{result.scatterHit ? SCATTER.label : result.lineWins[0]?.label}
							{#if result.lineWins.length > 1}· {result.lineWins.length} lines{/if}
						</div>
						<div class="text-2xl">+🪙 {formatGold(result.win)}</div>
						{#if result.cost > 0 && result.win < result.cost}
							<div class="text-[0.65rem] opacity-70">less than the 🪙{formatGold(result.cost)} staked</div>
						{/if}
					</div>
				{:else}
					<div class="rounded-xl px-4 py-2 text-center text-sm bg-base-300/85 text-base-content/60">
						{result.wasFree ? 'No line — free spin' : `No line — 🪙${formatGold(result.cost)}`}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Result grid: what actually landed, with winning cells lit -->
	{#if result?.grid}
		<div class="rounded-2xl bg-base-100/50 border border-white/5 p-3">
			<div class="flex items-start gap-3">
				<div class="grid grid-cols-3 gap-1">
					{#each Array(ROWS) as _, row}
						{#each result.grid as reelCol, reel}
							{@const id = reelCol[row]}
							{@const s = SYMBOLS[id]}
							{@const lit = litCells.has(`${reel}:${row}`)}
							<span
								class="size-9 rounded-md grid place-items-center text-lg border transition-all {lit
									? 'border-amber-300 ring-2 ring-amber-300/60 scale-105'
									: 'border-black/20 opacity-40'}"
								style="background:{s.color};color:{s.text}">{s.glyph}</span
							>
						{/each}
					{/each}
				</div>
				<div class="min-w-0 flex-1 text-sm">
					{#if result.lineWins.length || result.scatterHit}
						<div class="space-y-0.5">
							{#each result.lineWins as lw}
								<div class="flex justify-between gap-2">
									<span class="text-base-content/60 truncate">{lw.name} · {lw.label}</span>
									<span class="font-bold text-accent whitespace-nowrap">🪙{formatGold(lw.amount)}</span>
								</div>
							{/each}
							{#if result.scatterHit}
								<div class="flex justify-between gap-2">
									<span class="text-fuchsia-300 truncate">
										{result.scatterCells.length} Boosters
										{#if result.awardedFreeSpins}· {result.awardedFreeSpins} free spins{/if}
									</span>
									<span class="font-bold text-accent whitespace-nowrap">🪙{formatGold(result.scatterWin)}</span>
								</div>
							{/if}
						</div>
					{:else}
						<div class="text-base-content/40">No winning line.</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error text-sm py-2">{error}</div>
	{/if}

	<!-- Lines + bet -->
	<div class="rounded-2xl bg-base-100/60 border border-white/5 p-3 space-y-3" class:opacity-60={freeLeft > 0}>
		<div class="flex items-center justify-between gap-2">
			<span class="text-[0.65rem] uppercase tracking-widest text-base-content/40">Paylines</span>
			<div class="join">
				{#each LINE_OPTIONS as n}
					<button
						class="join-item btn btn-xs {lines === n ? 'btn-primary' : 'btn-ghost'} font-bold"
						onclick={() => setLines(n)}
						disabled={spinning || freeLeft > 0}
					>
						{n}
					</button>
				{/each}
			</div>
		</div>

		<div class="flex items-center justify-between gap-2">
			<span class="text-[0.65rem] uppercase tracking-widest text-base-content/40">Bet per line</span>
			<button
				class="btn btn-xs btn-outline btn-warning font-bold"
				onclick={betMax}
				disabled={spinning || freeLeft > 0 || affordable === null || bet === affordable}
			>
				MAX
			</button>
		</div>

		<div class="flex items-center gap-3">
			<button
				class="btn btn-circle btn-sm btn-ghost text-xl font-black"
				onclick={() => nudge(-1)}
				disabled={spinning || freeLeft > 0 || bet === MIN_BET}
				aria-label="Lower bet">−</button
			>
			<div class="flex-1 text-center">
				<div class="text-xl font-black tabular-nums text-accent leading-none">🪙 {formatGold(bet)}</div>
				<div class="text-[0.65rem] text-base-content/45 mt-1">
					× {lines} {lines === 1 ? 'line' : 'lines'} = 🪙{formatGold(stake)} a spin
				</div>
			</div>
			<button
				class="btn btn-circle btn-sm btn-ghost text-xl font-black"
				onclick={() => nudge(1)}
				disabled={spinning || freeLeft > 0 || bet === MAX_BET || (affordable !== null && bet >= affordable)}
				aria-label="Raise bet">+</button
			>
		</div>

		<div class="grid grid-cols-6 gap-1">
			{#each BET_LEVELS as level}
				<button
					class="btn btn-xs {bet === level ? 'btn-primary' : 'btn-ghost'} font-bold tabular-nums"
					onclick={() => setBet(level)}
					disabled={spinning || freeLeft > 0 || level * lines > gold}
				>
					{level}
				</button>
			{/each}
		</div>
	</div>

	<!-- Controls -->
	<div class="flex items-center gap-3">
		<div class="flex-1 rounded-xl bg-base-100/60 border border-white/5 px-4 py-2.5">
			<div class="text-[0.65rem] uppercase tracking-widest text-base-content/40">Balance</div>
			<div class="text-xl font-black tabular-nums text-accent">🪙 {formatGold(gold)}</div>
		</div>
		<button
			class="btn btn-lg flex-1 font-black text-lg shadow-xl {freeLeft > 0
				? 'btn-secondary shadow-secondary/30'
				: 'btn-primary shadow-primary/30'}"
			onclick={spin}
			disabled={!canSpin}
		>
			{#if spinning}
				<span class="loading loading-spinner"></span>
			{:else if freeLeft > 0}
				FREE SPIN
			{:else if affordable === null}
				Not enough gold
			{:else}
				SPIN · 🪙{formatGold(stake)}
			{/if}
		</button>
	</div>

	{#if session.spins > 0}
		<div class="grid grid-cols-4 gap-2 text-center">
			<div class="rounded-xl bg-base-100/50 p-2.5">
				<div class="text-lg font-black tabular-nums">{session.spins}</div>
				<div class="text-[0.65rem] text-base-content/45">Spins</div>
			</div>
			<div class="rounded-xl bg-base-100/50 p-2.5">
				<div class="text-lg font-black tabular-nums text-cyan-300">🪙{formatGold(session.won)}</div>
				<div class="text-[0.65rem] text-base-content/45">Won</div>
			</div>
			<div class="rounded-xl bg-base-100/50 p-2.5">
				<div class="text-lg font-black tabular-nums text-fuchsia-300">{session.bonuses}</div>
				<div class="text-[0.65rem] text-base-content/45">Bonuses</div>
			</div>
			<div class="rounded-xl bg-base-100/50 p-2.5">
				<div class="text-lg font-black tabular-nums {sessionNet >= 0 ? 'text-success' : 'text-error'}">
					{sessionNet >= 0 ? '+' : ''}{formatGold(sessionNet)}
				</div>
				<div class="text-[0.65rem] text-base-content/45">Net</div>
			</div>
		</div>
	{/if}

	<!-- Paytable -->
	<div class="rounded-2xl bg-base-100/50 border border-white/5 p-4">
		<div class="flex items-baseline justify-between mb-3">
			<span class="text-xs uppercase tracking-widest text-base-content/40">Paytable</span>
			<span class="text-[0.7rem] text-base-content/40">per line, at 🪙{formatGold(bet)}</span>
		</div>
		<div class="space-y-1.5">
			{#each payRows as row}
				{@const def = PAYTABLE[row.key]}
				<div class="flex items-center gap-3">
					<div class="flex gap-1 w-24 shrink-0">
						{#each row.icons as id}
							{@const s = SYMBOLS[id]}
							<span
								class="size-6 rounded-md grid place-items-center text-xs border border-black/20"
								style="background:{s.color};color:{s.text}">{s.glyph}</span
							>
						{/each}
					</div>
					<div class="flex-1 text-sm text-base-content/70 truncate">{def.label}</div>
					<div class="font-bold tabular-nums text-accent whitespace-nowrap">
						🪙{formatGold(def.mult * bet)}
					</div>
				</div>
			{/each}

			<div class="flex items-center gap-3 pt-1.5 mt-1.5 border-t border-white/5">
				<div class="flex gap-1 w-24 shrink-0">
					{#each Array(SCATTER.need) as _}
						<span
							class="size-6 rounded-md grid place-items-center text-xs border border-black/20"
							style="background:{SYMBOLS.scatter.color};color:{SYMBOLS.scatter.text}"
							>{SYMBOLS.scatter.glyph}</span
						>
					{/each}
				</div>
				<div class="flex-1 text-sm text-fuchsia-300 truncate">
					Anywhere → {SCATTER.freeSpins} free spins
				</div>
				<div class="font-bold tabular-nums text-accent whitespace-nowrap">
					🪙{formatGold(SCATTER.payMult * stake)}
				</div>
			</div>
		</div>

		<p class="text-[0.7rem] text-base-content/40 mt-3 leading-relaxed">
			<span class="inline-grid place-items-center size-4 rounded align-text-bottom" style="background:{SYMBOLS.wild.color};color:{SYMBOLS.wild.text}">{SYMBOLS.wild.glyph}</span>
			is wild on any line but never substitutes for
			<span class="inline-grid place-items-center size-4 rounded align-text-bottom" style="background:{SYMBOLS.scatter.color};color:{SYMBOLS.scatter.text}">{SYMBOLS.scatter.glyph}</span>,
			which pays from anywhere on the grid and on the total bet. One win per line, best only.
			Payouts are multipliers of your stake, so the return is identical at every bet and line
			count — more lines buy more coverage, not better value. Reels are rolled on the server with
			a cryptographic RNG, which also validates the stake.
		</p>
	</div>

	{#if data.slots?.spins > 0}
		<div class="rounded-2xl bg-base-100/50 border border-white/5 p-4">
			<div class="text-xs uppercase tracking-widest text-base-content/40 mb-3">All time</div>
			<div class="grid grid-cols-4 gap-3 text-center">
				<div>
					<div class="text-lg font-black tabular-nums">{formatGold(data.slots.spins)}</div>
					<div class="text-[0.65rem] text-base-content/45">Spins</div>
				</div>
				<div>
					<div class="text-lg font-black tabular-nums text-fuchsia-300">{formatGold(data.slots.bonuses)}</div>
					<div class="text-[0.65rem] text-base-content/45">Bonuses</div>
				</div>
				<div>
					<div class="text-lg font-black tabular-nums {data.slots.net >= 0 ? 'text-success' : 'text-error'}">
						{data.slots.net >= 0 ? '+' : ''}{formatGold(data.slots.net)}
					</div>
					<div class="text-[0.65rem] text-base-content/45">Net gold</div>
				</div>
				<div>
					<div class="text-lg font-black tabular-nums">
						{data.slots.returnPct != null ? (data.slots.returnPct * 100).toFixed(0) + '%' : '—'}
					</div>
					<div class="text-[0.65rem] text-base-content/45">Your return</div>
				</div>
			</div>
		</div>
	{/if}
</div>
