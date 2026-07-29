<script>
	import { invalidateAll } from '$app/navigation';
	import PlayingCard from '$lib/components/PlayingCard.svelte';
	import {
		BET_LEVELS,
		MIN_BET,
		MAX_BET,
		DEFAULT_BET,
		DECKS,
		BLACKJACK_PAYOUT,
		basicStrategy,
		maxAffordableBet,
		stepBet
	} from '$lib/blackjack.js';
	import { formatGold } from '$lib/economy.js';

	let { data } = $props();

	let table = $state(data.table);
	let gold = $state(data.wallet?.gold ?? 0);
	let bet = $state(Math.min(DEFAULT_BET, maxAffordableBet(data.wallet?.gold ?? 0) ?? MIN_BET));
	let busy = $state(false);
	let error = $state(null);
	let showHint = $state(false);

	let session = $state({ rounds: 0, net: 0 });

	const affordable = $derived(maxAffordableBet(gold));
	const inPlay = $derived(table?.phase === 'player');
	const canDeal = $derived(!busy && !inPlay && affordable !== null && gold >= bet);
	const activeHand = $derived(table?.hands?.find((h) => h.active) ?? null);

	// The hint runs the same basic-strategy table the verifier uses to measure
	// the house edge, so it is the genuinely correct play, not a guess.
	const hint = $derived.by(() => {
		if (!activeHand || !table?.dealer?.length) return null;
		const moves = activeHand.moves;
		if (!moves?.length) return null;
		try {
			const m = basicStrategy(activeHand.cards, table.dealer[0], {
				canDouble: moves.includes('double'),
				canSplit: moves.includes('split')
			});
			return moves.includes(m) ? m : moves.includes('hit') ? 'hit' : 'stand';
		} catch {
			return null;
		}
	});

	async function send(action, extra = {}) {
		if (busy) return;
		busy = true;
		error = null;
		try {
			const res = await fetch('/api/blackjack', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, ...extra })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message || 'That move failed.');
			}
			const r = await res.json();
			const wasPlaying = table?.phase === 'player' || action === 'deal';
			table = r.table;
			gold = r.gold;
			if (table?.phase === 'done' && wasPlaying) {
				session.rounds += 1;
				session.net += table.totalDelta ?? 0;
			}
			invalidateAll();
		} catch (e) {
			error = e.message;
		} finally {
			busy = false;
		}
	}

	const OUTCOME = {
		blackjack: { label: 'BLACKJACK', cls: 'bg-gradient-to-r from-amber-300 to-fuchsia-400 text-black' },
		win: { label: 'WIN', cls: 'bg-success text-success-content' },
		push: { label: 'PUSH', cls: 'bg-base-300 text-base-content/70' },
		lose: { label: 'LOSE', cls: 'bg-error/80 text-error-content' }
	};

	const MOVE_LABEL = { hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split' };
</script>

<svelte:head><title>Blackjack · PackRipper</title></svelte:head>

<!-- Two zones from xl up: the felt on the left, the bet box, rules and history in a
     rail on the right. The split follows document order, so the phone layout is
     the same single column it was. Below xl the felt keeps the full width — a rail
     there would squeeze the table narrower than a five-card hand. -->
<div class="space-y-4 pb-24 lg:pb-0 xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_24rem] xl:gap-6 xl:items-start xl:space-y-0">
	<div class="space-y-4 xl:sticky xl:top-7">
		<div>
			<h1 class="text-2xl lg:text-3xl font-black tracking-tight">Blackjack</h1>
			<p class="text-sm text-base-content/50">
				{DECKS} decks · dealer stands on soft 17 · blackjack pays {BLACKJACK_PAYOUT === 1.5 ? '3:2' : BLACKJACK_PAYOUT}
			</p>
		</div>

		<!-- Table -->
		<!-- With a column to itself the felt gets real table depth and the hands sit in
		     the middle of it, the way they would across a real one. -->
		<div class="rounded-2xl border border-emerald-900/60 bg-gradient-to-b from-emerald-950 to-slate-950 p-4 lg:p-8 space-y-4 lg:space-y-10 shadow-2xl lg:min-h-[30rem] lg:flex lg:flex-col lg:justify-center">
			<!-- Dealer -->
			<div>
				<div class="flex items-center gap-2 mb-1.5 lg:justify-center">
					<span class="text-[0.65rem] uppercase tracking-widest text-white/40">Dealer</span>
					{#if table}
						<span class="badge badge-xs bg-black/40 border-white/10 text-white/80 font-bold tabular-nums">
							{table.dealerHidden ? `${table.dealerValue.total}+` : table.dealerValue.total}
							{#if !table.dealerHidden && table.dealerValue.bust}· BUST{/if}
						</span>
					{/if}
				</div>
				<div class="flex gap-1.5 lg:gap-2.5 min-h-[4.4rem] lg:min-h-[6.9rem] items-center lg:justify-center">
					{#if table}
						{#each table.dealer as c}
							<PlayingCard card={c} />
						{/each}
						{#if table.dealerHidden}
							<PlayingCard hidden />
						{/if}
					{:else}
						<span class="text-white/25 text-sm">Place a bet to deal.</span>
					{/if}
				</div>
			</div>

			<div class="border-t border-white/5"></div>

			<!-- Player hands -->
			<div>
				<div class="text-[0.65rem] uppercase tracking-widest text-white/40 mb-1.5 lg:text-center">
					You{#if table && table.hands.length > 1}&nbsp;· {table.hands.length} hands{/if}
				</div>
				<div class="space-y-2">
					{#each table?.hands ?? [] as hand, i}
						<!-- The hand's frame hugs the cards on desktop; stretched across the
						     whole felt it read as a panel rather than a hand. -->
						<div
							class="rounded-xl p-2 lg:p-3 lg:w-fit lg:mx-auto transition-all {hand.active
								? 'bg-white/10 ring-2 ring-amber-300/70'
								: 'bg-white/[0.03]'}"
						>
							<div class="flex items-center gap-2 lg:gap-3 flex-wrap lg:justify-center">
								<div class="flex gap-1.5 lg:gap-2.5">
									{#each hand.cards as c}
										<PlayingCard card={c} small={table.hands.length > 1} dim={hand.value.bust} />
									{/each}
								</div>
								<div class="flex flex-col gap-1">
									<span class="badge badge-xs bg-black/40 border-white/10 text-white/80 font-bold tabular-nums">
										{hand.value.total}{hand.value.soft ? ' soft' : ''}{hand.value.bust ? ' · BUST' : ''}
									</span>
									<span class="text-[0.6rem] text-white/40 tabular-nums">
										🪙{formatGold(hand.bet)}{hand.doubled ? ' ×2' : ''}
									</span>
								</div>
								{#if hand.outcome}
									{@const o = OUTCOME[hand.outcome]}
									<span class="badge badge-sm border-0 font-black ml-auto {o.cls}">{o.label}</span>
									<span
										class="text-sm font-black tabular-nums {hand.delta > 0
											? 'text-success'
											: hand.delta < 0
												? 'text-error'
												: 'text-white/50'}"
									>
										{hand.delta > 0 ? '+' : ''}{formatGold(hand.delta)}
									</span>
								{/if}
							</div>
						</div>
					{:else}
						<div class="h-[4.4rem] lg:h-[6.9rem] grid place-items-center text-white/25 text-sm">No hand in play.</div>
					{/each}
				</div>
			</div>

			{#if table?.phase === 'done' && table.totalDelta !== null}
				<div
					class="rounded-xl px-4 py-2 text-center font-black {table.totalDelta > 0
						? 'bg-success/20 text-success'
						: table.totalDelta < 0
							? 'bg-error/20 text-error'
							: 'bg-base-300/40 text-base-content/60'}"
				>
					{table.totalDelta > 0 ? '+' : ''}🪙{formatGold(table.totalDelta)}
				</div>
			{/if}
		</div>

		{#if error}
			<div class="alert alert-error text-sm py-2">{error}</div>
		{/if}
	</div>

	<div class="space-y-4">
		<!-- Actions -->
		{#if inPlay && activeHand}
			<div class="space-y-2">
				<!-- Four moves squeezed onto one line is fine on a phone; in the rail they
				     get two rows of comfortably large targets instead. -->
				<div class="flex gap-2 xl:grid xl:grid-cols-2">
					{#each activeHand.moves as move}
						<button
							class="btn flex-1 xl:flex-none xl:btn-lg font-black {move === 'stand'
								? 'btn-error'
								: move === 'hit'
									? 'btn-primary'
									: 'btn-warning'} {showHint && hint === move ? 'ring-2 ring-offset-2 ring-offset-base-100 ring-amber-300' : ''}"
							onclick={() => send(move)}
							disabled={busy}
						>
							{MOVE_LABEL[move]}
						</button>
					{/each}
				</div>
				<label class="flex items-center gap-2 text-xs text-base-content/50 cursor-pointer">
					<input type="checkbox" class="toggle toggle-xs" bind:checked={showHint} />
					Show basic strategy
					{#if showHint && hint}
						<span class="badge badge-xs badge-warning font-bold">{MOVE_LABEL[hint]}</span>
					{/if}
				</label>
			</div>
		{:else}
			<!-- Bet + deal -->
			<div class="rounded-2xl bg-base-100/60 border border-white/5 p-3 space-y-3">
				<div class="flex items-center justify-between gap-2">
					<span class="text-[0.65rem] uppercase tracking-widest text-base-content/40">Bet</span>
					<button
						class="btn btn-xs btn-outline btn-warning font-bold"
						onclick={() => (bet = affordable ?? MIN_BET)}
						disabled={busy || affordable === null || bet === affordable}>MAX</button
					>
				</div>
				<div class="flex items-center gap-3">
					<button
						class="btn btn-circle btn-sm btn-ghost text-xl font-black"
						onclick={() => (bet = stepBet(bet, -1, gold))}
						disabled={busy || bet === MIN_BET}
						aria-label="Lower bet">−</button
					>
					<div class="flex-1 text-center text-2xl font-black tabular-nums text-accent">
						🪙 {formatGold(bet)}
					</div>
					<button
						class="btn btn-circle btn-sm btn-ghost text-xl font-black"
						onclick={() => (bet = stepBet(bet, 1, gold))}
						disabled={busy || bet === MAX_BET || (affordable !== null && bet >= affordable)}
						aria-label="Raise bet">+</button
					>
				</div>
				<div class="grid grid-cols-6 gap-1">
					{#each BET_LEVELS as level}
						<button
							class="btn btn-xs {bet === level ? 'btn-primary' : 'btn-ghost'} font-bold tabular-nums"
							onclick={() => (bet = level)}
							disabled={busy || level > gold}>{level}</button
						>
					{/each}
				</div>
			</div>

			<div class="flex items-center gap-3 xl:flex-col xl:items-stretch">
				<div class="flex-1 xl:flex-none rounded-xl bg-base-100/60 border border-white/5 px-4 py-2.5 xl:flex xl:items-baseline xl:justify-between xl:gap-2">
					<div class="text-[0.65rem] uppercase tracking-widest text-base-content/40">Balance</div>
					<div class="text-xl font-black tabular-nums text-accent">🪙 {formatGold(gold)}</div>
				</div>
				<button
					class="btn btn-lg btn-primary flex-1 xl:flex-none xl:h-16 font-black text-lg shadow-xl shadow-primary/30"
					onclick={() => send('deal', { bet })}
					disabled={!canDeal}
				>
					{#if busy}
						<span class="loading loading-spinner"></span>
					{:else if affordable === null}
						Not enough gold
					{:else}
						DEAL · 🪙{formatGold(bet)}
					{/if}
				</button>
			</div>
		{/if}

		{#if session.rounds > 0}
			<div class="grid grid-cols-2 gap-2 text-center">
				<div class="rounded-xl bg-base-100/50 p-2.5">
					<div class="text-lg font-black tabular-nums">{session.rounds}</div>
					<div class="text-[0.65rem] text-base-content/45">Rounds this session</div>
				</div>
				<div class="rounded-xl bg-base-100/50 p-2.5">
					<div class="text-lg font-black tabular-nums {session.net >= 0 ? 'text-success' : 'text-error'}">
						{session.net >= 0 ? '+' : ''}{formatGold(session.net)}
					</div>
					<div class="text-[0.65rem] text-base-content/45">Net</div>
				</div>
			</div>
		{/if}

		<!-- Rules -->
		<div class="rounded-2xl bg-base-100/50 border border-white/5 p-4 text-sm space-y-1.5">
			<div class="text-xs uppercase tracking-widest text-base-content/40 mb-2">House rules</div>
			<div class="flex justify-between"><span class="text-base-content/60">Decks</span><span class="font-bold">{DECKS}, reshuffled at 75%</span></div>
			<div class="flex justify-between"><span class="text-base-content/60">Dealer</span><span class="font-bold">Stands on all 17s</span></div>
			<div class="flex justify-between"><span class="text-base-content/60">Blackjack</span><span class="font-bold">Pays 3:2</span></div>
			<div class="flex justify-between"><span class="text-base-content/60">Double</span><span class="font-bold">Any two cards, after split too</span></div>
			<div class="flex justify-between"><span class="text-base-content/60">Split</span><span class="font-bold">Up to 4 hands; aces get one card</span></div>
			<div class="flex justify-between"><span class="text-base-content/60">House edge</span><span class="font-bold text-accent">0.47% with correct play</span></div>
			<p class="text-[0.7rem] text-base-content/40 pt-2 leading-relaxed">
				No insurance: it is a side bet on the dealer holding a ten, paying 2:1 on a shot closer to
				9:4, so declining is always better. Rather than offer a trap, the dealer just peeks. The shoe
				is shuffled with a cryptographic RNG and never leaves the server — the hole card is withheld
				until it is legitimately turned over. Every move is re-checked server-side against the real
				table state.
			</p>
		</div>

		{#if data.stats?.rounds > 0}
			<div class="rounded-2xl bg-base-100/50 border border-white/5 p-4">
				<div class="text-xs uppercase tracking-widest text-base-content/40 mb-3">All time</div>
				<div class="grid grid-cols-4 xl:grid-cols-2 gap-3 text-center">
					<div>
						<div class="text-lg font-black tabular-nums">{formatGold(data.stats.rounds)}</div>
						<div class="text-[0.65rem] text-base-content/45">Rounds</div>
					</div>
					<div>
						<div class="text-lg font-black tabular-nums text-amber-300">{formatGold(data.stats.blackjacks)}</div>
						<div class="text-[0.65rem] text-base-content/45">Blackjacks</div>
					</div>
					<div>
						<div class="text-lg font-black tabular-nums {data.stats.net >= 0 ? 'text-success' : 'text-error'}">
							{data.stats.net >= 0 ? '+' : ''}{formatGold(data.stats.net)}
						</div>
						<div class="text-[0.65rem] text-base-content/45">Net gold</div>
					</div>
					<div>
						<div class="text-lg font-black tabular-nums">
							{data.stats.edge != null ? (data.stats.edge * 100).toFixed(1) + '%' : '—'}
						</div>
						<div class="text-[0.65rem] text-base-content/45">Your edge lost</div>
					</div>
				</div>
				<div class="text-[0.7rem] text-base-content/40 text-center mt-2">
					{data.stats.wins}W · {data.stats.pushes}P · {data.stats.losses}L over {data.stats.hands} hands
				</div>
			</div>
		{/if}
	</div>
</div>
