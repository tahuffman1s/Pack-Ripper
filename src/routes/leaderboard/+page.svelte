<script>
	import { page } from '$app/stores';
	import { formatGold } from '$lib/economy.js';

	let { data } = $props();

	const me = $derived($page.data.user?.username);

	/** Which board is showing on a phone. Desktop shows them all at once. */
	let tab = $state(data.boards[0]?.id ?? 'networth');
	const current = $derived(data.boards.find((b) => b.id === tab) ?? data.boards[0]);

	function value(board, v) {
		if (board.unit === 'count') return v.toLocaleString('en-US');
		if (board.unit === 'net') return `${v >= 0 ? '+' : '−'}🪙${formatGold(Math.abs(v))}`;
		return `🪙${formatGold(v)}`;
	}

	const MEDALS = ['🥇', '🥈', '🥉'];

	const rel = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
	function ago(ms) {
		const s = Math.round((ms - Date.now()) / 1000);
		if (s > -60) return rel.format(Math.round(s), 'second');
		if (s > -3600) return rel.format(Math.round(s / 60), 'minute');
		if (s > -86400) return rel.format(Math.round(s / 3600), 'hour');
		return rel.format(Math.round(s / 86400), 'day');
	}
</script>

<svelte:head><title>Leaderboard · PackRipper</title></svelte:head>

<div class="mb-4">
	<h1 class="text-2xl lg:text-3xl font-black">Leaderboard</h1>
	<p class="text-base-content/60 text-sm">
		{data.players.toLocaleString('en-US')} {data.players === 1 ? 'player' : 'players'} · updated every
		time you load this page.
	</p>
</div>

<!-- Phones get one board at a time behind a scrolling tab strip; from lg there is
     room to show every board at once, which is the version worth reading. -->
<div class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-2 mb-3 lg:hidden">
	{#each data.boards as b (b.id)}
		<button
			class="btn btn-xs whitespace-nowrap {tab === b.id ? 'btn-primary' : 'btn-ghost border border-white/10'}"
			onclick={() => (tab = b.id)}
		>
			<span>{b.icon}</span> {b.title}
		</button>
	{/each}
</div>

{#snippet boardCard(board)}
	<div class="card bg-base-100/70 border border-white/5 shadow-lg">
		<div class="card-body p-4 gap-2">
			<div class="flex items-baseline gap-2">
				<span class="text-lg leading-none">{board.icon}</span>
				<h2 class="font-bold">{board.title}</h2>
				{#if board.you}
					<span class="ml-auto badge badge-sm badge-primary badge-outline font-bold whitespace-nowrap">
						you · #{board.you.place}
					</span>
				{/if}
			</div>
			<p class="text-xs text-base-content/50 -mt-1">{board.blurb}</p>

			{#if !board.entries.length}
				<p class="text-sm text-base-content/40 py-3">Nobody has made this board yet.</p>
			{:else}
				<ol class="mt-1">
					{#each board.entries as e (e.id)}
						<li
							class="flex items-center gap-2.5 py-1.5 border-b border-white/5 last:border-0 {e.username ===
							me
								? 'text-primary font-semibold'
								: ''}"
						>
							<span class="w-6 shrink-0 text-center text-sm tabular-nums text-base-content/40">
								{MEDALS[e.place - 1] ?? e.place}
							</span>
							{#if e.image}
								<img
									src={e.image}
									alt=""
									loading="lazy"
									class="w-6 h-[2.1rem] shrink-0 rounded object-cover border border-white/10"
								/>
							{/if}
							<span class="min-w-0 flex-1 truncate text-sm">
								{e.username}
								{#if e.caption}
									<span class="block text-[0.65rem] text-base-content/40 truncate font-normal">
										{e.caption}
									</span>
								{/if}
							</span>
							<span
								class="shrink-0 text-sm font-bold tabular-nums whitespace-nowrap {board.unit === 'net' &&
								e.value < 0
									? 'text-error'
									: 'text-accent'}"
							>
								{value(board, e.value)}
							</span>
						</li>
					{/each}
				</ol>
				{#if board.ranked > board.entries.length}
					<p class="text-[0.65rem] text-base-content/35 mt-1">
						{(board.ranked - board.entries.length).toLocaleString('en-US')} more ranked
					</p>
				{/if}
			{/if}
		</div>
	</div>
{/snippet}

<div class="lg:hidden">
	{#if current}{@render boardCard(current)}{/if}
</div>

<div class="hidden lg:grid lg:grid-cols-2 2xl:grid-cols-3 gap-4 items-start">
	{#each data.boards as b (b.id)}
		{@render boardCard(b)}
	{/each}
</div>

<!-- ── the noticeboard ─────────────────────────────────────────── -->
<div class="card bg-base-100/70 border border-white/5 shadow-lg mt-4">
	<div class="card-body p-4 gap-2">
		<div class="flex items-baseline gap-2">
			<span class="text-lg leading-none">📣</span>
			<h2 class="font-bold">Recent news</h2>
			<span class="ml-auto text-[0.65rem] text-base-content/40">last 7 days</span>
		</div>
		{#if !data.news.length}
			<p class="text-sm text-base-content/40 py-3">
				Nothing yet. Pull something worth 🪙 50,000, or anything serialized, and everyone hears about
				it.
			</p>
		{:else}
			<ul class="lg:grid lg:grid-cols-2 lg:gap-x-6">
				{#each data.news as n (n.id)}
					<li class="flex items-start gap-2.5 py-2 border-b border-white/5 last:border-0">
						{#if n.image}
							<img
								src={n.image}
								alt=""
								loading="lazy"
								class="w-8 h-[2.8rem] shrink-0 rounded object-cover border border-white/10"
							/>
						{:else}
							<span class="w-8 shrink-0 text-center text-xl leading-none">
								{n.kind === 'slot' ? '🎰' : n.kind === 'serial' ? '🔢' : '🃏'}
							</span>
						{/if}
						<div class="min-w-0 flex-1">
							<div class="text-sm font-semibold leading-snug">{n.headline}</div>
							{#if n.detail}
								<div class="text-xs text-base-content/50 truncate">{n.detail}</div>
							{/if}
						</div>
						<div class="shrink-0 text-right">
							{#if n.gold}
								<div class="text-sm font-bold text-accent tabular-nums">🪙{formatGold(n.gold)}</div>
							{/if}
							<div class="text-[0.6rem] text-base-content/35 whitespace-nowrap">{ago(n.at)}</div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
