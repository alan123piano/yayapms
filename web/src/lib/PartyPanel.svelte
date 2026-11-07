<script lang="ts">
	import { MAX_PARTIES, NEW_PARTY_COLORS } from './config';
	import type { Simulation } from './model';
	import { nextPartyId, presetParties } from './parties';
	import Scrubber, { stepped } from './Scrubber.svelte';
	import type { Party } from './types';

	interface Props {
		parties: Party[];
		/** groups (states) available on the current map, for regional parties */
		groups: string[];
		/** the current scenario, to show each party's national share */
		sim: Simulation | null;
	}
	let { parties = $bindable(), groups, sim }: Props = $props();

	const SHARE = stepped(0, 50, 1);
	const SHARE_TICKS = SHARE.filter((x) => x % 5 === 0);
	const fmtPct = (x: number) => `${x}%`;
	/** this party's national share now, from the model */
	const now = (p: Party) => Math.round((sim?.group({}).shares[p.id] ?? 0) * 100);

	function shareLabel(p: Party): string {
		return p.states.length ? ` in ${p.states.join(', ')}` : ' nationally';
	}

	let extras = $derived(parties.filter((p) => !p.core));
	let dParty = $derived(parties.find((p) => p.id === 'D'));
	let rParty = $derived(parties.find((p) => p.id === 'R'));
	let totalShare = $derived(extras.filter((p) => !p.states.length).reduce((a, p) => a + p.share, 0));

	function add() {
		const used = new Set(parties.map((p) => p.color));
		parties.push({
			id: nextPartyId(parties),
			name: 'New party',
			color: NEW_PARTY_COLORS.find((c) => !used.has(c)) ?? '#888888',
			share: 10,
			fromD: 50,
			states: [],
			appeals: []
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

	const DRAW = stepped(0, 100, 5);
	const drawTick = (fromD: number) =>
		fromD === 50 ? 'even' : `all ${(fromD > 50 ? dParty?.name : rParty?.name) ?? (fromD > 50 ? 'D' : 'R')}`;

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
					<span title="Its share where it runs, before group appeals, if it pulled evenly from both sides">Base share <b>{p.share}%</b>{shareLabel(p)} <span class="muted">(now {now(p)}%)</span></span>
					<Scrubber bind:value={p.share} stops={SHARE} ticks={SHARE_TICKS} labels={[0, 25, 50]} format={fmtPct} />
				</label>
				<label>
					<span title="How much more strongly it attracts one side's voters than the other's">Pulls <b>{drawLabel(p.fromD)}</b></span>
					<Scrubber bind:value={p.fromD} stops={DRAW} labels={[0, 50, 100]} format={drawTick} origin={50} />
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
			{#if !p.core}<p class="muted small hint">Appeals to voter groups: set in Voter groups above.</p>{/if}
		</div>
{/each}

<div class="actions">
		<button type="button" onclick={add} disabled={parties.length >= MAX_PARTIES}>+ Add party</button>
		<button type="button" onclick={loadPreset}>Load example scenario</button>
	</div>
{#if extras.length}
	<!-- reserved space: dragging a share slider past the threshold must not shift the panel -->
	<p class="warn small" class:hidden={totalShare <= 80} aria-hidden={totalShare <= 80}>National shares add up to {totalShare}%: the big two are nearly gone.</p>
{/if}
{#if extras.length}
	<p class="muted small">
		A new party wins over each side's voters at the same rate in every district where it runs, so
		it is strongest where the side it pulls from is. Its appeals to voter groups are set in Voter
		groups, and Vote by group shows where every party ends up.
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
	.states {
		width: 100%;
	}
	.hint {
		margin: 6px 0 0;
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
	.hidden {
		visibility: hidden;
	}
</style>
