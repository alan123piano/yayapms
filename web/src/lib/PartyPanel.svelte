<script lang="ts">
	import { MAX_APPEALS, MAX_PARTIES, NEW_PARTY_COLORS } from './config';
	import { describe, filterKey, type GroupOption } from './demographics';
	import type { Simulation } from './model';
	import { nextPartyId, presetParties } from './parties';
	import Scrubber, { stepped } from './Scrubber.svelte';
	import type { Appeal, Party } from './types';

	interface Props {
		parties: Party[];
		/** groups (states) available on the current map, for regional parties */
		groups: string[];
		/** voter groups a party can target (empty if the election has no demographic data) */
		audiences: GroupOption[];
		/** the current scenario, to show where each target actually lands */
		sim: Simulation | null;
	}
	let { parties = $bindable(), groups, audiences, sim }: Props = $props();

	const PCT = stepped(0, 100, 1);
	const PCT_TICKS = PCT.filter((x) => x % 10 === 0);
	const SHARE = stepped(0, 50, 1);
	const SHARE_TICKS = SHARE.filter((x) => x % 5 === 0);
	const fmtPct = (x: number) => `${x}%`;

	/** this party's current share of a group (%), from the model */
	const now = (p: Party, a: Appeal) => Math.round((sim?.group(a.filter).shares[p.id] ?? 0) * 100);

	/** options for one target row: groups the party doesn't already target, plus this row's own
	 *  (kept even if its custom group was since deleted) */
	function optionsFor(p: Party, a: Appeal): GroupOption[] {
		const mine = filterKey(a.filter);
		const taken = new Set(p.appeals.map((x) => filterKey(x.filter)));
		const opts = audiences.filter((o) => o.key === mine || !taken.has(o.key));
		if (!opts.some((o) => o.key === mine)) {
			opts.push({ key: mine, label: describe(a.filter, Object.keys(a.filter)), filter: a.filter, custom: true });
		}
		return opts;
	}
	const dimsOf = (opts: GroupOption[]) => [...new Set(opts.filter((o) => !o.custom).map((o) => o.dim ?? ''))];

	function addAppeal(p: Party) {
		const taken = new Set(p.appeals.map((x) => filterKey(x.filter)));
		const o = audiences.find((x) => !taken.has(x.key));
		if (!o) return;
		const a: Appeal = { filter: structuredClone($state.snapshot(o.filter)), share: 0 };
		a.share = now(p, a); // start where the party already is, so adding a target moves nothing
		p.appeals.push(a);
	}
	function setAppealGroup(p: Party, k: number, key: string) {
		const o = audiences.find((x) => x.key === key);
		if (!o) return;
		const a: Appeal = { filter: structuredClone($state.snapshot(o.filter)), share: 0 };
		a.share = now(p, a);
		p.appeals[k] = a;
	}
	function shareLabel(p: Party): string {
		return p.states.length ? ` in ${p.states.join(', ')}` : p.appeals.length ? '' : ' nationally';
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
					<span>{p.appeals.length ? 'Everyone else' : 'Vote share'} <b>{p.share}%</b>{shareLabel(p)}</span>
					<Scrubber bind:value={p.share} stops={SHARE} ticks={SHARE_TICKS} labels={[0, 25, 50]} format={fmtPct} />
				</label>
				<label>
					<span>Draws <b>{drawLabel(p.fromD)}</b></span>
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
			{#each p.appeals as a, k (k)}
				{@const opts = optionsFor(p, a)}
				<div class="appeal">
					<div class="row">
						<select value={filterKey(a.filter)} onchange={(e) => setAppealGroup(p, k, e.currentTarget.value)} aria-label="Target group">
							{#each dimsOf(opts) as d (d)}
								<optgroup label={d}>
									{#each opts.filter((o) => !o.custom && (o.dim ?? '') === d) as o (o.key)}<option value={o.key}>{o.label}</option>{/each}
								</optgroup>
							{/each}
							{#if opts.some((o) => o.custom)}
								<optgroup label="Custom">
									{#each opts.filter((o) => o.custom) as o (o.key)}<option value={o.key}>{o.label}</option>{/each}
								</optgroup>
							{/if}
						</select>
						<button type="button" class="x" onclick={() => p.appeals.splice(k, 1)} aria-label="Stop targeting this group">×</button>
					</div>
					<label>
						<span>Wins <b>{a.share}%</b> of them <span class="muted">(now {now(p, a)}%)</span></span>
						<Scrubber bind:value={a.share} stops={PCT} ticks={PCT_TICKS} labels={[0, 50, 100]} format={fmtPct} />
					</label>
				</div>
			{/each}
			{#if audiences.length}
				<button type="button" class="link" onclick={() => addAppeal(p)} disabled={p.appeals.length >= MAX_APPEALS}>+ target a voter group</button>
			{/if}
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
		A party wins over voters from each side at the same rate in every district where it runs, so
		it is strongest where its source party is. Targets set its share of a group nationally; the
		Vote by group table shows where every party ends up. Each district goes to whoever gets the
		most votes.
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
	.appeal {
		margin-top: 8px;
		padding-left: 8px;
		border-left: 2px solid var(--border);
	}
	.appeal select {
		flex: 1;
		min-width: 0;
		font-size: 0.85rem;
	}
	.appeal label {
		margin-top: 4px;
	}
	.appeal label > span {
		white-space: nowrap;
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
