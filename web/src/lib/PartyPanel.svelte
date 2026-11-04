<script lang="ts">
	import { EXTRA_COLORS, MAX_PARTIES, nextPartyId, presetParties } from './parties';
	import type { Party } from './types';

	interface Props {
		parties: Party[];
		/** groups (states) available on the current map, for regional parties */
		groups: string[];
	}
	let { parties = $bindable(), groups }: Props = $props();

	let extras = $derived(parties.filter((p) => !p.core));
	let dParty = $derived(parties.find((p) => p.id === 'D'));
	let rParty = $derived(parties.find((p) => p.id === 'R'));
	let totalShare = $derived(extras.filter((p) => !p.states.length).reduce((a, p) => a + p.share, 0));

	function add() {
		const used = new Set(parties.map((p) => p.color));
		parties.push({
			id: nextPartyId(parties),
			name: 'New party',
			color: EXTRA_COLORS.find((c) => !used.has(c)) ?? '#888888',
			share: 10,
			fromD: 50,
			states: []
		});
	}

	function remove(id: string) {
		parties = parties.filter((p) => p.id !== id);
	}

	function loadPreset() {
		parties = presetParties(parties.filter((p) => p.core));
	}

	function setStates(p: Party, text: string) {
		p.states = text
			.split(/[\s,]+/)
			.map((s) => s.trim().toUpperCase())
			.filter((s) => s && groups.includes(s));
	}

	function drawLabel(fromD: number) {
		if (fromD >= 50) return `${fromD}% from ${dParty?.name ?? 'D'}`;
		return `${100 - fromD}% from ${rParty?.name ?? 'R'}`;
	}
</script>

{#each parties as p (p.id)}
		<div class="party" class:extra={!p.core}>
			<div class="row">
				<input type="color" bind:value={p.color} aria-label="{p.name} color" />
				<input class="name" bind:value={p.name} maxlength="40" aria-label="Party name" />
				{#if !p.core}
					<button type="button" class="x" onclick={() => remove(p.id)} aria-label="Remove {p.name}">×</button>
				{/if}
			</div>
			{#if !p.core}
				<label>
					<span>Vote share <b>{p.share}%</b>{p.states.length ? ` in ${p.states.join(', ')}` : ' nationally'}</span>
					<input type="range" min="0" max="50" step="1" bind:value={p.share} />
				</label>
				<label>
					<span>Draws <b>{drawLabel(p.fromD)}</b></span>
					<input type="range" min="0" max="100" step="5" bind:value={p.fromD} class="draw" />
				</label>
				<label>
					<span>Runs in</span>
					<input
						class="states"
						value={p.states.join(', ')}
						placeholder="all states (or e.g. TX, OK)"
						onchange={(e) => setStates(p, e.currentTarget.value)}
					/>
				</label>
			{/if}
		</div>
{/each}

<div class="actions">
		<button type="button" onclick={add} disabled={parties.length >= MAX_PARTIES}>+ Add party</button>
		<button type="button" onclick={loadPreset}>Load example scenario</button>
	</div>
{#if totalShare > 80}<p class="warn small">National shares add up to {totalShare}%: the big two are nearly gone.</p>{/if}
{#if extras.length}
	<p class="muted small">
		Each new party wins the same fraction of its source party's voters everywhere it runs (UK-style
		proportional swing), and each district goes to whoever gets the most votes.
	</p>
{/if}

<style>
	.party {
		margin-bottom: 8px;
	}
	.party.extra {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px;
		background: var(--surface);
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.row input[type='color'] {
		width: 36px;
		height: 32px;
		padding: 0;
		flex: none;
	}
	.name {
		flex: 1;
		min-width: 0;
	}
	.x {
		padding: 2px 10px;
		font-size: 1.1rem;
		line-height: 1;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: 8px;
		font-size: 0.85rem;
		color: var(--muted);
	}
	label b {
		color: var(--fg);
		font-weight: 600;
	}
	input[type='range'] {
		width: 100%;
	}
	.draw {
		accent-color: var(--fg);
	}
	.states {
		width: 100%;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 6px 0;
	}
	.warn {
		color: var(--danger);
	}
</style>
