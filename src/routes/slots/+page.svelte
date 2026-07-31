<script>
	import { invalidateAll } from '$app/navigation';
	import SlotMachine2D from '$lib/components/SlotMachine2D.svelte';
	import {
		BET_LEVELS,
		LINE_OPTIONS,
		MIN_BET,
		MAX_BET,
		DEFAULT_BET,
		DEFAULT_LINES,
		PAYLINES,
		PAYS,
		PAYTABLE,
		SCATTER_NEED,
		SCATTER_TIERS,
		PACK_TIERS,
		SYMBOLS,
		NREELS,
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
	// A bonus round in progress dictates the stake — adopt it so the controls and
	// the banner show what is actually being played, not a stale local choice.
	let lines = $state(data.freeSpins?.lines ?? DEFAULT_LINES);
	let bet = $state(data.freeSpins?.lineBet ?? DEFAULT_BET);
	let freeLeft = $state(data.freeSpins?.remaining ?? 0);
	/** The stake the server locked in for the bonus round, authoritative while it runs. */
	let lockedStake = $state(data.freeSpins ? { lineBet: data.freeSpins.lineBet, lines: data.freeSpins.lines } : null);

	let session = $state({ spins: 0, staked: 0, won: 0, bonuses: 0, packs: 0 });

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
			// The spin already happened on the server; if the reels somehow are not
			// mounted, settle anyway rather than leaving the page stuck spinning.
			if (machine) machine.spinTo(held.stops);
			else settle();
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
		if (held.prize) session.packs += 1;
		held = null;
		spinning = false;
		invalidateAll();
	}

	/** Cells that are part of a winning line, for the reels' own readout. */
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

	/**
	 * The paytable, as one row per symbol with a column per run length. Built from
	 * PAYS rather than listed by hand so a retune cannot leave the screen lying.
	 */
	const PAY_ROWS = [
		{ cls: 'wild', icon: 'wild' },
		{ cls: 'mythic', icon: 'mythic' },
		{ cls: 'foil', icon: 'foil' },
		{ cls: 'mana', icon: 'r' }
	];
	const RUNS = [5, 4, 3, 2];

	const scatterRows = $derived(
		Object.entries(SCATTER_TIERS)
			.map(([count, t]) => ({ count: Number(count), ...t }))
			.sort((a, b) => b.count - a.count)
	);
</script>

<svelte:head><title>Mana Machine · PackRipper</title></svelte:head>

<!-- Two zones from xl up: the machine and its readout on the left, everything you
     touch or look up in a rail on the right. The split follows the document order,
     so the phone still reads as one column in exactly the old sequence. Below xl
     there is not enough width for a rail as well as a full-size cabinet, so it
     stays one (wider, centred) column. -->
<div class="space-y-4 pb-24 lg:pb-0 xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_24rem] xl:gap-6 xl:items-start xl:space-y-0">
	<div class="space-y-4 xl:sticky xl:top-7">
		<div>
			<h1 class="text-2xl lg:text-3xl font-black tracking-tight">Mana Machine</h1>
			<p class="text-sm text-base-content/50">
				{NREELS} reels × 3 rows, {PAYLINES.length} paylines. Pays gold, free spins and booster packs.
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

		<!-- The machine. The reels ARE the result readout: winning cells light up in
		     place and the paylines are traced across them, so there is no separate
		     grid to keep in sync. The cabinet hugs the reels on desktop and centres,
		     rather than stretching a phone-width picture across the whole column. -->
		<div class="rounded-2xl overflow-hidden bg-gradient-to-b from-base-100 to-base-300 border border-white/10 shadow-2xl lg:w-fit lg:mx-auto">
			<SlotMachine2D
				bind:this={machine}
				onlanded={settle}
				lit={litCells}
				winLines={result?.lineWins ?? []}
				{lines}
			/>

			{#if result}
				<div class="px-3 pb-3">
					{#if result.win > 0 || result.prize}
						<div
							class="rounded-xl px-4 py-2.5 text-center font-black shadow-xl bg-gradient-to-r from-amber-300 via-fuchsia-400 to-cyan-300 text-black"
							class:animate-bounce={result.win >= result.stake * 20 || result.packTier === 'vault'}
						>
							<div class="text-[0.65rem] uppercase tracking-widest opacity-80">
								{result.scatterHit ? result.scatterLabel : result.lineWins[0]?.label}
								{#if result.lineWins.length > 1}· {result.lineWins.length} lines{/if}
							</div>
							{#if result.win > 0}
								<div class="text-2xl">+🪙 {formatGold(result.win)}</div>
							{/if}
							{#if result.prize}
								<div class="text-sm leading-tight mt-0.5">
									+ {result.prize.setName} {result.prize.packName}
									<span class="opacity-70">(🪙{formatGold(result.prize.priceGold)})</span>
								</div>
							{/if}
							{#if result.cost > 0 && result.win + (result.prize?.priceGold ?? 0) < result.cost}
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

		<!-- Where the pack prize went, when one landed. -->
		{#if result?.prize}
			<a
				href="/packs"
				class="block rounded-2xl border border-primary/40 bg-primary/10 p-3 hover:border-primary/70 transition-colors"
			>
				<div class="flex items-center gap-3">
					<span class="text-3xl leading-none">📦</span>
					<div class="min-w-0 flex-1">
						<div class="text-[0.65rem] uppercase tracking-widest text-primary font-bold">
							{result.prize.tierLabel}
						</div>
						<div class="font-bold truncate">{result.prize.setName} · {result.prize.packName}</div>
						<div class="text-xs text-base-content/60">
							Worth 🪙{formatGold(result.prize.priceGold)}{result.prize.changeGold
								? ` — plus 🪙${formatGold(result.prize.changeGold)} change`
								: ''}. It is in your vault.
						</div>
					</div>
					<span class="text-base-content/30">›</span>
				</div>
			</a>
		{/if}

		<!-- What paid, line by line -->
		{#if result && (result.lineWins.length || result.scatterHit)}
			<div class="rounded-2xl bg-base-100/50 border border-white/5 p-3 text-sm space-y-0.5">
				{#each result.lineWins as lw}
					<div class="flex justify-between gap-2">
						<span class="text-base-content/60 truncate">
							<span class="font-bold text-base-content/40">{lw.line + 1}</span>
							{lw.name} · {lw.label}
						</span>
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
		{/if}

		{#if error}
			<div class="alert alert-error text-sm py-2">{error}</div>
		{/if}
	</div>

	<div class="space-y-4">
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

			<div class="grid grid-cols-4 gap-1">
				{#each BET_LEVELS as level}
					<button
						class="btn btn-xs {bet === level ? 'btn-primary' : 'btn-ghost'} font-bold tabular-nums"
						onclick={() => setBet(level)}
						disabled={spinning || freeLeft > 0 || level * lines > gold}
					>
						{formatGold(level)}
					</button>
				{/each}
			</div>
		</div>

		<!-- Controls -->
		<div class="flex items-center gap-3 xl:flex-col xl:items-stretch">
			<div class="flex-1 xl:flex-none rounded-xl bg-base-100/60 border border-white/5 px-4 py-2.5 xl:flex xl:items-baseline xl:justify-between xl:gap-2">
				<div class="text-[0.65rem] uppercase tracking-widest text-base-content/40">Balance</div>
				<div class="text-xl font-black tabular-nums text-accent">🪙 {formatGold(gold)}</div>
			</div>
			<button
				class="btn btn-lg flex-1 xl:flex-none xl:h-16 font-black text-lg shadow-xl {freeLeft > 0
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
			<div class="grid grid-cols-4 xl:grid-cols-2 gap-2 text-center">
				<div class="rounded-xl bg-base-100/50 p-2.5">
					<div class="text-lg font-black tabular-nums">{session.spins}</div>
					<div class="text-[0.65rem] text-base-content/45">Spins</div>
				</div>
				<div class="rounded-xl bg-base-100/50 p-2.5">
					<div class="text-lg font-black tabular-nums text-cyan-300">🪙{formatGold(session.won)}</div>
					<div class="text-[0.65rem] text-base-content/45">Won</div>
				</div>
				<div class="rounded-xl bg-base-100/50 p-2.5">
					<div class="text-lg font-black tabular-nums text-primary">{session.packs}</div>
					<div class="text-[0.65rem] text-base-content/45">Packs</div>
				</div>
				<div class="rounded-xl bg-base-100/50 p-2.5">
					<div class="text-lg font-black tabular-nums {sessionNet >= 0 ? 'text-success' : 'text-error'}">
						{sessionNet >= 0 ? '+' : ''}{formatGold(sessionNet)}
					</div>
					<div class="text-[0.65rem] text-base-content/45">Net</div>
				</div>
			</div>
		{/if}

		<!-- ── Booster prizes ─────────────────────────────────────── -->
		<div class="rounded-2xl bg-base-100/50 border border-fuchsia-400/25 p-4">
			<div class="flex items-baseline justify-between mb-2">
				<span class="text-xs uppercase tracking-widest text-fuchsia-300">Booster prizes</span>
				<span class="text-[0.7rem] text-base-content/40">Boosters anywhere</span>
			</div>
			<div class="space-y-2">
				{#each scatterRows as row}
					<div class="flex items-center gap-2.5">
						<div class="flex gap-0.5 w-16 shrink-0">
							{#each Array(row.count) as _}
								<span
									class="size-4 rounded grid place-items-center text-[0.55rem] border border-black/20"
									style="background:{SYMBOLS.scatter.color};color:{SYMBOLS.scatter.text}"
									>{SYMBOLS.scatter.glyph}</span
								>
							{/each}
						</div>
						<div class="min-w-0 flex-1">
							<div class="text-sm font-bold truncate">{PACK_TIERS[row.tier].label}</div>
							<div class="text-[0.65rem] text-base-content/50">
								🪙{formatGold(row.payMult * stake)} + a pack near 🪙{formatGold(row.packMult * stake)} + {row.freeSpins} free spins
							</div>
						</div>
					</div>
				{/each}
			</div>
			<p class="text-[0.7rem] text-base-content/40 mt-3 leading-relaxed">
				A pack prize is a budget, not a named product — {SCATTER_NEED} Boosters is worth about your
				stake, five is worth 150 times it — and the shop hands over something real that costs about
				that much, with the difference paid as change. So a bigger stake wins better packs, and a
				budget too small for anything on the shelf simply arrives as gold. Free spins never award more
				free spins, but they can still win a pack.
			</p>
		</div>

		<!-- ── Paytable ──────────────────────────────────────────── -->
		<div class="rounded-2xl bg-base-100/50 border border-white/5 p-4">
			<div class="flex items-baseline justify-between mb-3">
				<span class="text-xs uppercase tracking-widest text-base-content/40">Paytable</span>
				<span class="text-[0.7rem] text-base-content/40">per line, at 🪙{formatGold(bet)}</span>
			</div>

			<div class="overflow-x-auto -mx-1 px-1">
				<table class="w-full text-right tabular-nums">
					<thead>
						<tr class="text-[0.6rem] uppercase tracking-widest text-base-content/35">
							<th class="text-left font-medium pb-1">from the left</th>
							{#each RUNS as run}
								<th class="font-medium pb-1 pl-2">{run}×</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each PAY_ROWS as row}
							{@const s = SYMBOLS[row.icon]}
							<tr class="border-t border-white/5">
								<td class="text-left py-1.5">
									<span class="inline-flex items-center gap-1.5">
										<span
											class="size-6 rounded-md grid place-items-center text-xs border border-black/20"
											style="background:{s.color};color:{s.text}">{s.glyph}</span
										>
										<span class="text-sm text-base-content/70">
											{row.cls === 'mana' ? 'Any colour' : s.label}
										</span>
									</span>
								</td>
								{#each RUNS as run}
									<td class="py-1.5 pl-2 font-bold text-accent text-xs whitespace-nowrap">
										{PAYS[row.cls][run] ? formatGold(PAYS[row.cls][run] * bet) : '—'}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<p class="text-[0.7rem] text-base-content/40 mt-3 leading-relaxed">
				<span class="inline-grid place-items-center size-4 rounded align-text-bottom" style="background:{SYMBOLS.wild.color};color:{SYMBOLS.wild.text}">{SYMBOLS.wild.glyph}</span>
				is wild on any line but never substitutes for
				<span class="inline-grid place-items-center size-4 rounded align-text-bottom" style="background:{SYMBOLS.scatter.color};color:{SYMBOLS.scatter.text}">{SYMBOLS.scatter.glyph}</span>,
				which pays from anywhere on the grid and on the total bet. Lines pay left to right and only the
				best win on a line counts. Payouts are multipliers of your stake, so the return is identical at
				every bet and line count — more lines buy more coverage, not better value. The top prize is
				{formatGold(PAYTABLE.wild5.mult)}× a line: 🪙{formatGold(PAYTABLE.wild5.mult * MAX_BET)} at the
				top of the ladder. Reels are rolled on the server with a cryptographic RNG, which also
				validates the stake.
			</p>
		</div>

		{#if data.slots?.spins > 0}
			<div class="rounded-2xl bg-base-100/50 border border-white/5 p-4">
				<div class="text-xs uppercase tracking-widest text-base-content/40 mb-3">All time</div>
				<div class="grid grid-cols-4 xl:grid-cols-2 gap-3 text-center">
					<div>
						<div class="text-lg font-black tabular-nums">{formatGold(data.slots.spins)}</div>
						<div class="text-[0.65rem] text-base-content/45">Spins</div>
					</div>
					<div>
						<div class="text-lg font-black tabular-nums text-primary">{formatGold(data.slots.packsWon)}</div>
						<div class="text-[0.65rem] text-base-content/45">Packs won</div>
					</div>
					<div>
						<div class="text-lg font-black tabular-nums {data.slots.net >= 0 ? 'text-success' : 'text-error'}">
							{data.slots.net >= 0 ? '+' : ''}{formatGold(data.slots.net)}
						</div>
						<div class="text-[0.65rem] text-base-content/45">Net worth</div>
					</div>
					<div>
						<div class="text-lg font-black tabular-nums">
							{data.slots.returnPct != null ? (data.slots.returnPct * 100).toFixed(0) + '%' : '—'}
						</div>
						<div class="text-[0.65rem] text-base-content/45">Your return</div>
					</div>
				</div>
				{#if data.slots.best}
					<div class="text-[0.7rem] text-base-content/45 mt-3 text-center">
						Best spin: 🪙{formatGold(data.slots.best.win)}
						{#if data.slots.best.label}· {data.slots.best.label}{/if}
						{#if data.slots.best.pack}· {data.slots.best.pack}{/if}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
