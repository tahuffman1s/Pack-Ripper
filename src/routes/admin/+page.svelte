<script>
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { formatGold } from '$lib/economy.js';
	import { PACK_TYPES } from '$lib/packs.js';

	let { data } = $props();

	const me = $derived($page.data.user);

	// ── selection ──────────────────────────────────────────────
	let selectedId = $state(null);
	let query = $state('');

	const shown = $derived(
		data.users.filter((u) => u.username.toLowerCase().includes(query.trim().toLowerCase()))
	);
	// Re-derived from data.users, so it refreshes with the page after every action
	// rather than showing the balance the row had when it was clicked.
	const selected = $derived(data.users.find((u) => u.id === selectedId) || null);

	// ── the one call path ──────────────────────────────────────
	// Everything the panel does goes through POST /api/admin — the same endpoint
	// and the same dispatch table the CLI uses.
	let busy = $state(null);
	let err = $state(null);
	let note = $state(null);

	async function call(action, args = {}, label = action) {
		if (busy) return null;
		busy = label;
		err = null;
		note = null;
		try {
			const res = await fetch('/api/admin', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, ...args })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message || `${action} failed.`);
			await invalidateAll();
			return body;
		} catch (e) {
			err = e.message;
			return null;
		} finally {
			busy = null;
		}
	}

	// ── gold ───────────────────────────────────────────────────
	let goldAmount = $state('');
	let goldMode = $state('add'); // add | set

	async function submitGold() {
		const amount = Number(goldAmount);
		if (!Number.isFinite(amount) || (goldMode === 'add' && amount === 0)) {
			err = 'Enter an amount.';
			return;
		}
		const r = await call('gold', { user: selected.id, amount, set: goldMode === 'set' }, 'gold');
		if (r) {
			note = `${r.user}: 🪙${formatGold(r.before)} → 🪙${formatGold(r.after)}`;
			goldAmount = '';
		}
	}

	// ── packs ──────────────────────────────────────────────────
	let packSet = $state('');
	let packType = $state('');
	let packQty = $state('1');

	const setEntry = $derived(data.sets.find((s) => s.code === packSet) || null);
	const typesForSet = $derived(
		data.packTypeOrder.filter((t) => (setEntry?.packTypes || []).includes(t))
	);

	// Changing the set re-picks the product: a set that never sold a Collector
	// Booster must not be left with `collector` selected from the previous one.
	// typesForSet is a derived, so it already reflects the new packSet here.
	function setChanged() {
		packType = typesForSet[0] ?? '';
	}

	async function submitPacks() {
		if (!packSet || !packType) {
			err = 'Pick a set and a product.';
			return;
		}
		const r = await call(
			'packs',
			{ user: selected.id, setCode: packSet, packTypeId: packType, qty: Number(packQty) || 1 },
			'packs'
		);
		if (r) note = `Granted ${r.granted}× ${r.setCode.toUpperCase()} ${r.packTypeId} (worth 🪙${formatGold(r.worth)}).`;
	}

	// ── password ───────────────────────────────────────────────
	let newPassword = $state('');

	async function submitPassword() {
		const r = await call('password', { user: selected.id, password: newPassword }, 'password');
		if (r) {
			note = `Password set for ${r.user}; ${r.sessionsRevoked} session(s) signed out.`;
			newPassword = '';
		}
	}

	// ── destructive ────────────────────────────────────────────
	let confirmDelete = $state('');

	async function submitDelete() {
		if (confirmDelete !== selected.username) {
			err = 'Type the username exactly to confirm.';
			return;
		}
		const r = await call('delete', { user: selected.id, confirm: true }, 'delete');
		if (r) {
			note = `Deleted ${r.user}.`;
			confirmDelete = '';
			selectedId = null;
		}
	}

	function select(u) {
		selectedId = selectedId === u.id ? null : u.id;
		err = null;
		note = null;
		goldAmount = '';
		newPassword = '';
		confirmDelete = '';
	}

	// ── formatting ─────────────────────────────────────────────
	const dt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
	function when(ms) {
		return ms ? dt.format(new Date(ms)) : '—';
	}
	function ago(ms) {
		if (!ms) return 'never';
		const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.round(s / 60)}m ago`;
		if (s < 86400) return `${Math.round(s / 3600)}h ago`;
		return `${Math.round(s / 86400)}d ago`;
	}
	function uptime(s) {
		if (s < 60) return `${s}s`;
		if (s < 3600) return `${Math.floor(s / 60)}m`;
		if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
		return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
	}

	const ACTION_LABELS = {
		gold: '🪙 Gold',
		packs: '📦 Packs',
		'admin.grant': '🔑 Admin granted',
		'admin.revoke': '🔒 Admin revoked',
		password: '🔐 Password',
		logout: '🚪 Signed out',
		'stats.reset': '📊 Stats reset',
		unstick: '🔧 Unstuck',
		delete: '🗑️ Deleted'
	};
</script>

<svelte:head><title>Admin · PackRipper</title></svelte:head>

<div class="flex items-start justify-between gap-3 mb-4">
	<div>
		<h1 class="text-2xl lg:text-3xl font-black flex items-center gap-2">
			<span class="text-error">🔑</span> Admin
		</h1>
		<p class="text-base-content/60 text-sm">
			Signed in as <span class="font-semibold">{me?.username}</span> · everything here is logged
			below and takes effect immediately.
		</p>
	</div>
	<button class="btn btn-ghost btn-sm" onclick={() => invalidateAll()}>Refresh</button>
</div>

{#if err}
	<div class="alert alert-error mb-3 text-sm py-2">{err}</div>
{/if}
{#if note}
	<div class="alert alert-success mb-3 text-sm py-2">{note}</div>
{/if}

<!-- ── server ──────────────────────────────────────────────── -->
<div class="grid grid-cols-2 lg:grid-cols-4 gap-2 lg:gap-3 mb-3">
	{#each [
		{ label: 'Accounts', value: data.summary.users, icon: '👤' },
		{ label: 'Admins', value: data.summary.admins, icon: '🔑', cls: 'text-error' },
		{ label: 'Live sessions', value: data.summary.sessions, icon: '🔗' },
		{ label: 'Gold in circulation', value: data.summary.gold, icon: '🪙', cls: 'text-accent' },
		{ label: 'Cards owned', value: data.summary.cards, icon: '🃏' },
		{ label: 'Unopened packs', value: data.summary.packs, icon: '🎁' },
		{ label: 'Serials issued', value: data.summary.serialsIssued, icon: '🔢', cls: 'text-secondary' },
		{ label: 'Tables in play', value: data.summary.tablesOpen, icon: '♠️' }
	] as stat}
		<div class="card bg-base-100/60 border border-white/5">
			<div class="card-body p-3">
				<div class="flex items-center justify-between">
					<span class="text-lg">{stat.icon}</span>
					<span class="text-xl lg:text-2xl font-black {stat.cls || ''}">{formatGold(stat.value)}</span>
				</div>
				<div class="text-xs text-base-content/50">{stat.label}</div>
			</div>
		</div>
	{/each}
</div>

<div class="card bg-base-100/40 border border-white/5 mb-4">
	<div class="card-body p-3 gap-1 text-xs text-base-content/60">
		<div class="flex flex-wrap gap-x-5 gap-y-1">
			<span>Node <span class="font-mono">{data.summary.nodeVersion}</span></span>
			<span>Up {uptime(data.summary.uptimeSeconds)}</span>
			<span>
				CLI token:
				{#if data.summary.tokenAuth}
					<span class="text-success font-semibold">configured</span>
				{:else}
					<span class="text-warning font-semibold">not set</span> — <span class="font-mono">ADMIN_TOKEN</span> is
					unset, so <span class="font-mono">./admin.sh</span> cannot sign in.
				{/if}
			</span>
			{#if data.summary.envAdmins.length}
				<span>
					<span class="font-mono">ADMIN_USERNAMES</span>: {data.summary.envAdmins.join(', ')}
				</span>
			{/if}
		</div>
	</div>
</div>

<!-- ── storage ─────────────────────────────────────────────────
     The whole database is one file. Whether it was found on this boot is the
     difference between a mounted volume and one that quietly is not, so it is
     stated rather than left to be discovered after a wipe. -->
{#if data.summary.storage}
	{@const st = data.summary.storage}
	<div
		class="card mb-4 border {st.startedEmpty || st.refusedWrites || st.recoveredFrom
			? 'border-error/40 bg-error/5'
			: 'border-white/5 bg-base-100/40'}"
	>
		<div class="card-body p-3 gap-1 text-xs">
			<div class="flex items-center gap-2 font-bold text-sm">
				<span>💾 Storage</span>
				{#if st.startedEmpty}
					<span class="badge badge-sm badge-error font-bold">started empty</span>
				{:else if st.recoveredFrom}
					<span class="badge badge-sm badge-warning font-bold">recovered</span>
				{:else}
					<span class="badge badge-sm badge-success font-bold">loaded</span>
				{/if}
			</div>
			<div class="text-base-content/60 flex flex-wrap gap-x-5 gap-y-1">
				<span><span class="font-mono">{st.path}</span></span>
				{#if st.bytes != null}<span>{(st.bytes / 1024).toFixed(0)} KB</span>{/if}
				<span>{formatGold(st.usersAtLoad)} account(s) at load</span>
				<span>backup: {st.hasBackup ? 'yes' : 'not yet'}</span>
				{#if st.allowReset}<span class="text-warning font-mono">ALLOW_DB_RESET=1</span>{/if}
			</div>
			{#if st.startedEmpty}
				<p class="text-error mt-1">
					No database was found at that path on this boot. On a deployment that already had
					accounts, that means the volume is <strong>not mounted</strong> — mount Azure Files at
					<span class="font-mono">/app/.data</span> and restart. Nothing has been written yet, so
					the existing data is still intact; it will stay that way until someone changes something.
				</p>
			{/if}
			{#if st.recoveredFrom}
				<p class="text-warning mt-1">
					The main file was unusable and the data came from a backup. The bad file was kept at
					<span class="font-mono">{st.recoveredFrom}</span>.
				</p>
			{/if}
			{#if st.refusedWrites}
				<p class="text-error mt-1">
					Refused {st.refusedWrites} write(s) that would have erased accounts this process never
					loaded. Nothing is being saved right now — fix the mount and restart.
				</p>
			{/if}
		</div>
	</div>
{/if}

<!-- ── accounts ────────────────────────────────────────────── -->
<div class="flex items-center justify-between gap-3 mb-2">
	<h2 class="font-bold text-sm uppercase tracking-wide text-base-content/60">
		Accounts ({shown.length}{shown.length !== data.users.length ? ` of ${data.users.length}` : ''})
	</h2>
	<input
		class="input input-sm input-bordered w-40 lg:w-64"
		type="search"
		placeholder="Search username"
		bind:value={query}
	/>
</div>

<div class="card bg-base-100/70 border border-white/5 mb-4 overflow-hidden">
	<div class="overflow-x-auto">
		<table class="table table-sm">
			<thead>
				<tr class="text-base-content/50">
					<th>User</th>
					<th class="text-right">Gold</th>
					<th class="text-right hidden sm:table-cell">Cards</th>
					<th class="text-right hidden sm:table-cell">Packs</th>
					<th class="text-right hidden lg:table-cell">Collection</th>
					<th class="text-right hidden lg:table-cell">Opened</th>
					<th class="hidden lg:table-cell">Last seen</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each shown as u (u.id)}
					<tr
						class="hover:bg-base-200/40 cursor-pointer {selectedId === u.id ? 'bg-primary/10' : ''}"
						onclick={() => select(u)}
					>
						<td>
							<div class="flex items-center gap-2">
								<span class="font-semibold">{u.username}</span>
								{#if u.admin}
									<span class="badge badge-xs badge-error font-bold">admin</span>
								{/if}
								{#if u.id === me?.id}
									<span class="badge badge-xs badge-ghost">you</span>
								{/if}
							</div>
							<div class="text-[0.65rem] text-base-content/40">joined {when(u.createdAt)}</div>
						</td>
						<td class="text-right font-bold tabular-nums text-accent">{formatGold(u.gold)}</td>
						<td class="text-right tabular-nums hidden sm:table-cell">{formatGold(u.cards)}</td>
						<td class="text-right tabular-nums hidden sm:table-cell">{formatGold(u.packs)}</td>
						<td class="text-right tabular-nums hidden lg:table-cell text-secondary">
							{formatGold(u.collectionValue)}
						</td>
						<td class="text-right tabular-nums hidden lg:table-cell">{formatGold(u.packsOpened)}</td>
						<td class="hidden lg:table-cell text-xs text-base-content/50">{ago(u.lastSeenAt)}</td>
						<td class="text-right text-base-content/30">{selectedId === u.id ? '▾' : '▸'}</td>
					</tr>
				{/each}
				{#if !shown.length}
					<tr><td colspan="8" class="text-center text-base-content/40 py-6">No matching accounts.</td></tr>
				{/if}
			</tbody>
		</table>
	</div>
</div>

<!-- ── actions on one account ──────────────────────────────── -->
{#if selected}
	{@const u = selected}
	<div class="card bg-base-100/80 border border-primary/25 mb-4">
		<div class="card-body p-4 gap-4">
			<div class="flex items-start justify-between gap-3">
				<div>
					<div class="text-xs text-base-content/50 uppercase tracking-wide">Acting on</div>
					<div class="text-xl font-black flex items-center gap-2">
						{u.username}
						{#if u.admin}<span class="badge badge-sm badge-error font-bold">admin</span>{/if}
					</div>
					<div class="text-sm text-base-content/60">
						🪙{formatGold(u.gold)} · {formatGold(u.cards)} cards worth 🪙{formatGold(u.collectionValue)} ·
						{formatGold(u.packs)} unopened · {u.sessions} session{u.sessions === 1 ? '' : 's'}
					</div>
					<div class="text-[0.65rem] text-base-content/40 font-mono mt-0.5">{u.id}</div>
				</div>
				<button class="btn btn-ghost btn-xs btn-circle" onclick={() => (selectedId = null)} aria-label="Close">✕</button>
			</div>

			<div class="grid lg:grid-cols-2 gap-4">
				<!-- gold -->
				<div class="rounded-xl border border-accent/20 bg-accent/5 p-3">
					<div class="font-bold text-sm mb-2">🪙 Gold</div>
					<div class="flex flex-wrap items-center gap-2">
						<div class="join">
							<button
								class="btn btn-xs join-item {goldMode === 'add' ? 'btn-active' : ''}"
								onclick={() => (goldMode = 'add')}>Add</button
							>
							<button
								class="btn btn-xs join-item {goldMode === 'set' ? 'btn-active' : ''}"
								onclick={() => (goldMode = 'set')}>Set to</button
							>
						</div>
						<input
							class="input input-sm input-bordered w-32 tabular-nums"
							type="number"
							step="1"
							placeholder={goldMode === 'add' ? '±amount' : 'balance'}
							bind:value={goldAmount}
						/>
						<button class="btn btn-sm btn-accent font-bold" onclick={submitGold} disabled={busy === 'gold'}>
							{#if busy === 'gold'}<span class="loading loading-spinner loading-xs"></span>{/if}
							Apply
						</button>
					</div>
					<div class="flex flex-wrap gap-1 mt-2">
						{#each [1000, 10_000, 100_000, 1_000_000] as amt}
							<button
								class="btn btn-xs btn-ghost border border-white/10"
								onclick={() => {
									goldMode = 'add';
									goldAmount = String(amt);
									submitGold();
								}}
								disabled={!!busy}>+{formatGold(amt)}</button
							>
						{/each}
					</div>
					<p class="text-[0.65rem] text-base-content/40 mt-2">
						Add takes a negative number too. Granted gold is kept out of the player's own
						earned/spent figures, so their net profit stays honest.
					</p>
				</div>

				<!-- packs -->
				<div class="rounded-xl border border-primary/20 bg-primary/5 p-3">
					<div class="font-bold text-sm mb-2">📦 Grant unopened packs</div>
					<div class="flex flex-wrap items-center gap-2">
						<select class="select select-sm select-bordered w-44" bind:value={packSet} onchange={setChanged}>
							<option value="">Pick a set…</option>
							{#each data.sets as s}
								<option value={s.code}>{s.name} ({s.code.toUpperCase()})</option>
							{/each}
						</select>
						<select class="select select-sm select-bordered w-40" bind:value={packType} disabled={!typesForSet.length}>
							{#if !typesForSet.length}
								<option value="">Product</option>
							{/if}
							{#each typesForSet as t}
								<option value={t}>{PACK_TYPES[t]?.name || t}</option>
							{/each}
						</select>
						<input class="input input-sm input-bordered w-20 tabular-nums" type="number" min="1" bind:value={packQty} />
						<button class="btn btn-sm btn-primary font-bold" onclick={submitPacks} disabled={busy === 'packs'}>
							{#if busy === 'packs'}<span class="loading loading-spinner loading-xs"></span>{/if}
							Grant
						</button>
					</div>
					<p class="text-[0.65rem] text-base-content/40 mt-2">
						Free of charge, straight into their vault. Products offered are the ones that set
						really sold.
					</p>
				</div>

				<!-- access -->
				<div class="rounded-xl border border-white/10 bg-base-200/30 p-3">
					<div class="font-bold text-sm mb-2">🔐 Access</div>
					<div class="flex flex-wrap items-center gap-2">
						{#if u.admin}
							<button
								class="btn btn-sm btn-outline btn-error"
								onclick={() => call('admin', { user: u.id, value: false })}
								disabled={!!busy || u.id === me?.id || u.envAdmin}
							>
								Revoke admin
							</button>
						{:else}
							<button
								class="btn btn-sm btn-error font-bold"
								onclick={() => call('admin', { user: u.id, value: true })}
								disabled={!!busy}
							>
								Make admin
							</button>
						{/if}
						<button class="btn btn-sm btn-ghost border border-white/10" onclick={() => call('logout', { user: u.id })} disabled={!!busy}>
							Sign out everywhere
						</button>
					</div>
					{#if u.envAdmin}
						<p class="text-[0.65rem] text-warning mt-2">
							Admin via <span class="font-mono">ADMIN_USERNAMES</span> — remove them from that
							variable and restart to revoke.
						</p>
					{/if}
					<div class="flex flex-wrap items-center gap-2 mt-2">
						<input
							class="input input-sm input-bordered w-44"
							type="text"
							autocomplete="off"
							placeholder="New password"
							bind:value={newPassword}
						/>
						<button class="btn btn-sm" onclick={submitPassword} disabled={busy === 'password' || newPassword.length < 6}>
							{#if busy === 'password'}<span class="loading loading-spinner loading-xs"></span>{/if}
							Set password
						</button>
					</div>
				</div>

				<!-- repair -->
				<div class="rounded-xl border border-white/10 bg-base-200/30 p-3">
					<div class="font-bold text-sm mb-2">🔧 Repair</div>
					<div class="flex flex-wrap items-center gap-2">
						<button class="btn btn-sm btn-ghost border border-white/10" onclick={() => call('unstick', { user: u.id })} disabled={!!busy}>
							Clear table / free spins
						</button>
						<button class="btn btn-sm btn-ghost border border-white/10" onclick={() => call('reset-stats', { user: u.id })} disabled={!!busy}>
							Reset stats
						</button>
					</div>
					<p class="text-[0.65rem] text-base-content/40 mt-2">
						{#if u.atTable || u.freeSpins}
							Currently mid-game: {u.atTable ? 'a blackjack hand is open' : ''}{u.atTable && u.freeSpins ? ', ' : ''}{u.freeSpins ? `${u.freeSpins} free spins left` : ''}.
							Clearing forfeits the bet.
						{:else}
							Nothing in play. Clearing a wedged hand or spin round forfeits the bet; resetting
							stats keeps the wallet and cards.
						{/if}
					</p>
				</div>
			</div>

			<!-- delete -->
			<div class="rounded-xl border border-error/30 bg-error/5 p-3">
				<div class="font-bold text-sm text-error mb-1">🗑️ Delete account</div>
				<p class="text-xs text-base-content/60 mb-2">
					Removes the account, wallet, cards, packs, stats and sessions. Issued serial numbers stay
					retired — a 1/1 that has been pulled cannot exist twice. This cannot be undone.
				</p>
				<div class="flex flex-wrap items-center gap-2">
					<input
						class="input input-sm input-bordered w-44"
						type="text"
						autocomplete="off"
						placeholder="Type {u.username}"
						bind:value={confirmDelete}
					/>
					<button
						class="btn btn-sm btn-error font-bold"
						onclick={submitDelete}
						disabled={busy === 'delete' || confirmDelete !== u.username || u.id === me?.id}
					>
						{#if busy === 'delete'}<span class="loading loading-spinner loading-xs"></span>{/if}
						Delete permanently
					</button>
				</div>
			</div>
		</div>
	</div>
{:else}
	<div class="card bg-base-100/40 border border-white/5 mb-4">
		<div class="card-body p-4 text-sm text-base-content/50">Pick an account above to act on it.</div>
	</div>
{/if}

<!-- ── audit ───────────────────────────────────────────────── -->
<div class="card bg-base-100/70 border border-white/5">
	<div class="card-body p-4 gap-1">
		<h2 class="font-bold text-sm uppercase tracking-wide text-base-content/60 mb-1">
			Recent admin actions
		</h2>
		{#if !data.log.length}
			<p class="text-sm text-base-content/40">Nothing yet.</p>
		{/if}
		{#each data.log as entry (entry.id)}
			<div class="flex items-baseline gap-2 text-sm py-1 border-b border-white/5 last:border-0">
				<span class="text-xs text-base-content/40 tabular-nums w-32 shrink-0 hidden sm:inline">
					{when(entry.at)}
				</span>
				<span class="font-semibold shrink-0">{ACTION_LABELS[entry.action] || entry.action}</span>
				{#if entry.target}<span class="text-base-content/70">{entry.target}</span>{/if}
				{#if entry.detail}<span class="text-xs text-base-content/40 truncate">{entry.detail}</span>{/if}
				<!-- A CLI actor is already named `cli:<operator>`, so `via` needs no badge. -->
				<span class="ml-auto text-xs text-base-content/40 shrink-0">{entry.actor}</span>
			</div>
		{/each}
	</div>
</div>
