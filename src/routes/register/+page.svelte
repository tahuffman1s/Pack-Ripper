<script>
	import { enhance } from '$app/forms';
	import { formatGold } from '$lib/economy.js';
	let { form, data } = $props();
	let loading = $state(false);
</script>

<svelte:head><title>Create account · PackRipper</title></svelte:head>

<div class="min-h-dvh grid place-items-center px-5 py-10">
	<div class="w-full max-w-sm">
		<div class="text-center mb-8">
			<div class="inline-grid place-items-center size-16 rounded-2xl bg-gradient-to-br from-primary to-secondary text-3xl shadow-xl shadow-primary/30 mb-4">⚡</div>
			<h1 class="text-3xl font-black">Pack<span class="text-primary">Ripper</span></h1>
			<p class="text-base-content/60 mt-1">Create your vault.</p>
		</div>

		<form
			method="POST"
			use:enhance={() => {
				loading = true;
				return async ({ update }) => {
					await update();
					loading = false;
				};
			}}
			class="card bg-base-100/70 backdrop-blur border border-white/5 shadow-xl"
		>
			<div class="card-body gap-4">
				<h2 class="card-title">Sign up — get {formatGold(data.startingGold)} gold</h2>

				{#if form?.error}
					<div class="alert alert-error text-sm py-2">{form.error}</div>
				{/if}

				<label class="floating-label">
					<span>Username</span>
					<input name="username" value={form?.username ?? ''} required autocomplete="username"
						class="input input-bordered w-full" placeholder="3–20 letters/numbers" />
				</label>

				<label class="floating-label">
					<span>Password</span>
					<input name="password" type="password" required minlength="6" autocomplete="new-password"
						class="input input-bordered w-full" placeholder="At least 6 characters" />
				</label>

				<button class="btn btn-primary w-full mt-2" disabled={loading}>
					{#if loading}<span class="loading loading-spinner loading-sm"></span>{/if}
					Create account
				</button>

				<p class="text-center text-sm text-base-content/60">
					Already have one? <a href="/login" class="link link-primary font-semibold">Sign in</a>
				</p>
			</div>
		</form>
	</div>
</div>
