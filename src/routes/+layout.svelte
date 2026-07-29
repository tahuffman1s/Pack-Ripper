<script>
	import '../app.css';
	import { page } from '$app/stores';
	import { invalidateAll } from '$app/navigation';
	import { formatGold } from '$lib/economy.js';

	let { children, data } = $props();

	// ── Bulk Bin failsafe ──────────────────────────────────────
	// If the player can't spin, can't buy and has nothing to sell, they're in a
	// dead end. The shop lets them rummage the bulk bin so there is always a
	// way back. Eligibility is decided on the server.
	let claiming = $state(false);
	let rescued = $state(null);
	let rescueError = $state(null);

	async function claimBulkBin() {
		if (claiming) return;
		claiming = true;
		rescueError = null;
		try {
			const res = await fetch('/api/rescue', { method: 'POST' });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message || 'Could not open the bulk bin.');
			}
			rescued = await res.json();
			await invalidateAll();
		} catch (e) {
			rescueError = e.message;
		} finally {
			claiming = false;
		}
	}

	const NAV = [
		{ href: '/', label: 'Home', icon: 'home' },
		{ href: '/store', label: 'Store', icon: 'store' },
		{ href: '/packs', label: 'Packs', icon: 'packs' },
		{ href: '/collection', label: 'Cards', icon: 'cards' },
		{ href: '/slots', label: 'Slots', icon: 'slots' },
		{ href: '/blackjack', label: '21', icon: 'cardgame' },
		{ href: '/stats', label: 'Stats', icon: 'stats' }
	];

	// The admin panel is only linked for admins, and /admin is a 404 for everyone
	// else — a URL nobody is told about is one nobody probes.
	const nav = $derived(
		data.user?.admin ? [...NAV, { href: '/admin', label: 'Admin', icon: 'admin' }] : NAV
	);

	function isActive(href) {
		const p = $page.url.pathname;
		if (href === '/') return p === '/';
		return p === href || p.startsWith(href + '/');
	}
</script>

<!-- Nav glyphs, shared by the mobile bottom bar and the desktop rail. -->
{#snippet navIcon(icon)}
	{#if icon === 'home'}
		<svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
	{:else if icon === 'store'}
		<svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9h16l-1 11H5L4 9Z M4 9l1.5-5h13L20 9M9 13h6" stroke-linecap="round" stroke-linejoin="round"/></svg>
	{:else if icon === 'packs'}
		<svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 8h14" stroke-linecap="round"/></svg>
	{:else if icon === 'cards'}
		<svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="12" height="16" rx="2"/><path d="M8 5l4-2 7 3-1.5 14" stroke-linecap="round" stroke-linejoin="round"/></svg>
	{:else if icon === 'slots'}
		<svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 6v12M15 6v12" stroke-linecap="round"/></svg>
	{:else if icon === 'cardgame'}
		<svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="4" width="11" height="15" rx="2"/><path d="M4.5 7.5v11a2 2 0 0 0 2 2h8" stroke-linecap="round"/></svg>
	{:else if icon === 'admin'}
		<svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16.5 5.5 19 8M14 3.5 16.5 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
	{:else}
		<svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke-linecap="round" stroke-linejoin="round"/></svg>
	{/if}
{/snippet}

{#if data.user}
	<div class="min-h-dvh flex flex-col lg:flex-row">
		<!-- Desktop rail. Below lg it is absent and the bottom bar takes over, so the
		     phone layout is untouched; from lg up it reclaims the vertical space the
		     bottom bar and top bar were eating. -->
		<aside
			class="hidden lg:flex lg:flex-col lg:w-60 xl:w-64 lg:shrink-0 lg:sticky lg:top-0 lg:h-dvh lg:overflow-y-auto border-r border-white/5 bg-base-300/60 backdrop-blur-md px-3 py-4 gap-3"
		>
			<a href="/" class="flex items-center gap-2 font-black tracking-tight px-2">
				<span
					class="inline-grid place-items-center size-9 rounded-lg bg-gradient-to-br from-primary to-secondary text-primary-content shadow-lg text-lg"
					>⚡</span
				>
				<span class="text-xl">Pack<span class="text-primary">Ripper</span></span>
			</a>

			<a
				href="/store"
				class="flex items-center justify-between gap-2 rounded-xl bg-base-100/70 border border-accent/25 px-3 py-2.5 shadow-inner hover:border-accent/50 transition-colors"
			>
				<span class="text-[0.6rem] uppercase tracking-widest text-base-content/40">Gold</span>
				<span class="flex items-center gap-1.5">
					<span class="text-accent leading-none">🪙</span>
					<span class="font-black tabular-nums">{formatGold(data.wallet?.gold ?? 0)}</span>
				</span>
			</a>

			<nav class="flex flex-col gap-0.5">
				{#each nav as item}
					<a
						href={item.href}
						class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors {isActive(
							item.href
						)
							? 'bg-primary/15 text-primary'
							: 'text-base-content/60 hover:bg-base-100/60 hover:text-base-content'}"
					>
						{@render navIcon(item.icon)}
						<span>{item.label}</span>
						{#if item.icon === 'packs' && data.inventoryCount > 0}
							<span class="ml-auto badge badge-sm badge-primary font-bold">{data.inventoryCount}</span>
						{/if}
					</a>
				{/each}
			</nav>

			<form method="POST" action="/logout" class="mt-auto px-1">
				<button class="btn btn-ghost btn-sm btn-block justify-start text-base-content/40 hover:text-error font-medium">
					Log out
				</button>
			</form>
		</aside>

		<div class="flex-1 min-w-0 flex flex-col">
			<!-- Top bar -->
			<header
				class="sticky top-0 z-30 lg:hidden backdrop-blur-md bg-base-300/70 border-b border-white/5"
				style="padding-top: env(safe-area-inset-top, 0px);"
			>
				<div class="mx-auto max-w-2xl px-4 h-14 flex items-center justify-between gap-3">
					<a href="/" class="flex items-center gap-2 font-black tracking-tight">
						<span
							class="inline-grid place-items-center size-8 rounded-lg bg-gradient-to-br from-primary to-secondary text-primary-content shadow-lg"
							>⚡</span
						>
						<span class="text-lg">Pack<span class="text-primary">Ripper</span></span>
					</a>

					<a
						href="/store"
						class="flex items-center gap-1.5 rounded-full bg-base-100/80 border border-accent/30 px-3 py-1.5 shadow-inner"
					>
						<span class="text-accent text-base leading-none">🪙</span>
						<span class="font-bold tabular-nums">{formatGold(data.wallet?.gold ?? 0)}</span>
					</a>
				</div>
			</header>

			<!-- Page -->
			<main class="flex-1 mx-auto w-full max-w-2xl px-4 pt-4 pb-safe lg:max-w-6xl 2xl:max-w-7xl lg:px-8 lg:pt-7">
				{#if data.stuck}
					<div class="mb-4 rounded-2xl border border-warning/40 bg-warning/10 p-4">
						<div class="flex items-start gap-3">
							<span class="text-2xl leading-none">📦</span>
							<div class="min-w-0 flex-1">
								<div class="font-bold">Out of options</div>
								<p class="text-sm text-base-content/60 mt-0.5">
									No gold to spend, no packs to open and nothing worth selling. Have a rummage
									through the shop's bulk bin — keep whatever you find.
								</p>
								{#if rescueError}
									<div class="alert alert-error text-sm py-2 mt-2">{rescueError}</div>
								{/if}
								<button class="btn btn-warning btn-sm mt-3 font-bold" onclick={claimBulkBin} disabled={claiming}>
									{#if claiming}
										<span class="loading loading-spinner loading-xs"></span> Rummaging…
									{:else}
										Open the bulk bin
									{/if}
								</button>
							</div>
						</div>
					</div>
				{/if}

				{#if rescued}
					<div class="mb-4 rounded-2xl border border-success/40 bg-success/10 p-4">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<div class="font-bold">
									{#if rescued.cards.length}
										You dug out {rescued.cards.length} card{rescued.cards.length === 1 ? '' : 's'}{rescued.setName
											? ` from ${rescued.setName}`
											: ''}.
									{:else}
										The shop spotted you 🪙{formatGold(rescued.gold)}.
									{/if}
								</div>
								<p class="text-sm text-base-content/60 mt-0.5">
									{#if rescued.cards.length}
										Worth about 🪙{formatGold(rescued.worth.cards)} at the counter{rescued.gold
											? `, plus 🪙${formatGold(rescued.gold)} in change`
											: ''}. Sell them from your collection to get back in the game.
									{/if}
								</p>
								{#if rescued.cards.length}
									<div class="flex flex-wrap gap-1.5 mt-2">
										{#each rescued.cards.slice(0, 8) as c}
											<span class="badge badge-sm badge-ghost">{c.name}</span>
										{/each}
										{#if rescued.cards.length > 8}
											<span class="badge badge-sm badge-ghost">+{rescued.cards.length - 8} more</span>
										{/if}
									</div>
								{/if}
								<a href="/collection" class="btn btn-success btn-sm mt-3 font-bold">Go to collection</a>
							</div>
							<button class="btn btn-ghost btn-xs btn-circle" onclick={() => (rescued = null)} aria-label="Dismiss">✕</button>
						</div>
					</div>
				{/if}

				{@render children()}
			</main>

			<!-- Bottom nav -->
			<nav
				class="fixed bottom-0 inset-x-0 z-30 lg:hidden backdrop-blur-md bg-base-300/80 border-t border-white/5"
				style="padding-bottom: env(safe-area-inset-bottom, 0px);"
			>
				<!-- Column count follows the nav, which grows by one for an admin. Inline
				     rather than a `grid-cols-N` class so Tailwind has nothing to purge. -->
				<div
					class="mx-auto max-w-2xl grid"
					style="grid-template-columns: repeat({nav.length}, minmax(0, 1fr));"
				>
					{#each nav as item}
						<a
							href={item.href}
							class="relative flex flex-col items-center gap-0.5 py-2.5 text-[0.68rem] font-medium transition-colors {isActive(
								item.href
							)
								? 'text-primary'
								: 'text-base-content/55'}"
						>
							{@render navIcon(item.icon)}
							{#if item.icon === 'packs' && data.inventoryCount > 0}
								<span class="absolute top-1 right-1/2 translate-x-4 badge badge-xs badge-primary font-bold">{data.inventoryCount}</span>
							{/if}
							<span>{item.label}</span>
						</a>
					{/each}
				</div>
			</nav>
		</div>
	</div>
{:else}
	{@render children()}
{/if}
