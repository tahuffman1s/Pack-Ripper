<script>
	import { enhance } from '$app/forms';
	let { form } = $props();
	let loading = $state(false);
</script>

<svelte:head><title>Sign in · PackRipper</title></svelte:head>

<div class="min-h-dvh grid place-items-center px-5 py-10">
	<div class="w-full max-w-sm">
		<div class="text-center mb-8">
			<div class="inline-grid place-items-center size-16 rounded-2xl bg-gradient-to-br from-primary to-secondary text-3xl shadow-xl shadow-primary/30 mb-4">⚡</div>
			<h1 class="text-3xl font-black">Pack<span class="text-primary">Ripper</span></h1>
			<p class="text-base-content/60 mt-1">Rip Magic packs. Chase the mythic.</p>
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
				<h2 class="card-title">Welcome back</h2>

				{#if form?.error}
					<div class="alert alert-error text-sm py-2">{form.error}</div>
				{/if}

				<label class="floating-label">
					<span>Username</span>
					<input name="username" value={form?.username ?? ''} required autocomplete="username"
						class="input input-bordered w-full" placeholder="Username" />
				</label>

				<label class="floating-label">
					<span>Password</span>
					<input name="password" type="password" required autocomplete="current-password"
						class="input input-bordered w-full" placeholder="Password" />
				</label>

				<button class="btn btn-primary w-full mt-2" disabled={loading}>
					{#if loading}<span class="loading loading-spinner loading-sm"></span>{/if}
					Sign in
				</button>

				<p class="text-center text-sm text-base-content/60">
					New here? <a href="/register" class="link link-primary font-semibold">Create an account</a>
				</p>
			</div>
		</form>
		<p class="text-center text-xs text-base-content/40 mt-6">
			Start with <span class="text-accent font-semibold">1,000 gold</span> free. It's a simulator — no real money, ever.
		</p>
	</div>
</div>
