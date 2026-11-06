<script lang="ts">
	import { DEMO_DIM_LABELS, DEMO_LIMITS } from './config';
	import { describe, isActive, MAX_CUSTOM_SEGMENTS, type DemoSwing, type Filter, type Segment } from './demographics';
	import { swingLabel } from './format';
	import Scrubber, { stepped } from './Scrubber.svelte';
	import type { Simulation } from './model';
	import type { CellData } from './types';

	interface Props {
		/** the current scenario on the current map (for the electorate summary) */
		sim: Simulation;
		cells: CellData;
		swing: DemoSwing;
	}
	let { sim, cells, swing = $bindable() }: Props = $props();

	interface GroupStat { voterShare: number; demBefore: number; demAfter: number; turnoutAfter: number }

	const CUSTOM = 'custom';
	const VOTE = { stops: stepped(-DEMO_LIMITS.vote, DEMO_LIMITS.vote, 1), every: 5 };
	const TURNOUT = { stops: stepped(-DEMO_LIMITS.turnout, DEMO_LIMITS.turnout, 5), every: 5 };
	const fmtTurnout = (t: number) => (t ? `${t > 0 ? '+' : ''}${t}%` : '0');
	let picked = $state<string | null>(null);
	let tab = $derived(picked === CUSTOM || (picked && cells.order.includes(picked)) ? picked : cells.order[0]);

	/** rows shown on the current tab: one per group of the dimension, or the custom segments */
	let rows = $derived.by((): { id: string; filter: Filter; title: string; custom: boolean }[] => {
		if (tab === CUSTOM) {
			return swing.segments
				.filter((g) => g.custom)
				.map((g) => ({ id: g.id, filter: g.filter, title: describe(g.filter, cells.order), custom: true }));
		}
		return cells.dims[tab].map((g) => ({ id: `${tab}=${g}`, filter: { [tab]: [g] }, title: g, custom: false }));
	});
	let stats = $derived(
		rows.map((r): GroupStat => {
			const g = sim.group(r.filter);
			const dr = (g.shares.D ?? 0) + (g.shares.R ?? 0);
			return { voterShare: g.voterShare, demBefore: g.before.dem, demAfter: dr ? g.shares.D / dr : 0, turnoutAfter: g.turnout };
		})
	);
	let customCount = $derived(swing.segments.filter((g) => g.custom).length);
	const pct = (x: number) => `${Math.round(x * 100)}%`;

	const seg = (id: string) => swing.segments.find((g) => g.id === id);
	function update(id: string, filter: Filter, patch: Partial<Segment>, custom = false) {
		const cur = seg(id) ?? { id, filter, vote: 0, turnout: 0, custom: custom || undefined };
		const next = { ...cur, ...patch };
		const rest = swing.segments.filter((g) => g.id !== id);
		// drop untouched single-group segments so share links stay short
		swing = { segments: !next.custom && !next.vote && !next.turnout ? rest : [...rest, next] };
	}
	function addCustom() {
		let n = 1;
		while (seg(`c${n}`)) n++;
		update(`c${n}`, {}, {}, true);
	}
	function removeCustom(id: string) {
		swing = { segments: swing.segments.filter((g) => g.id !== id) };
	}
	function toggle(id: string, dim: string, group: string) {
		const f = { ...(seg(id)?.filter ?? {}) };
		const cur = f[dim] ?? [];
		f[dim] = cur.includes(group) ? cur.filter((x) => x !== group) : [...cur, group];
		if (!f[dim].length) delete f[dim];
		update(id, f, { filter: f });
	}
	const changed = (t: string) =>
		swing.segments.some((g) => (g.vote || g.turnout) && (t === CUSTOM ? g.custom : !g.custom && g.id.startsWith(`${t}=`)));
</script>

{#snippet sliders(id: string, filter: Filter, s: GroupStat, custom: boolean)}
	{@const v = seg(id)?.vote ?? 0}
	{@const t = seg(id)?.turnout ?? 0}
	<div class="stat">
		<span class="muted">{pct(s.voterShare)} of voters</span>
		<span class="dem">D {pct(s.demBefore)}{#if v || t}<span class="muted"> → </span>{pct(s.demAfter)}{/if}</span>
	</div>
	<label>
		<span>Vote <b>{v ? swingLabel(v) : '—'}</b></span>
		<Scrubber value={v} stops={VOTE.stops} ticks={VOTE.stops.filter((x) => x % VOTE.every === 0)}
			labels={[-DEMO_LIMITS.vote / 2, 0, DEMO_LIMITS.vote / 2]} format={swingLabel} origin={0}
			onchange={(x) => update(id, filter, { vote: x }, custom)} />
	</label>
	<label>
		<span>Turnout <b>{t ? fmtTurnout(t) : '—'}</b> <span class="muted">({pct(s.turnoutAfter)})</span></span>
		<Scrubber value={t} stops={TURNOUT.stops} labels={[-DEMO_LIMITS.turnout / 2, 0, DEMO_LIMITS.turnout / 2]}
			format={fmtTurnout} origin={0} onchange={(x) => update(id, filter, { turnout: x }, custom)} />
	</label>
{/snippet}

<div class="tabs" role="tablist" aria-label="Voter groups">
	{#each [...cells.order, CUSTOM] as d (d)}
		<button type="button" role="tab" aria-selected={tab === d} class:active={tab === d} onclick={() => (picked = d)}>
			{d === CUSTOM ? 'Custom' : (DEMO_DIM_LABELS[d] ?? d)}{#if changed(d)}<span class="dot" aria-label="(changed)"></span>{/if}
		</button>
	{/each}
</div>

{#each rows as row, i (row.id)}
	<div class="group">
		<div class="head">
			<b>{row.title}</b>
			{#if row.custom}
				<button type="button" class="link x" onclick={() => removeCustom(row.id)} aria-label="Remove group">remove</button>
			{/if}
		</div>
		{#if row.custom}
			{#each cells.order as dim (dim)}
				<div class="chips" aria-label={DEMO_DIM_LABELS[dim] ?? dim}>
					<span class="muted">{DEMO_DIM_LABELS[dim] ?? dim}</span>
					{#each cells.dims[dim] as g (g)}
						<button type="button" class:on={row.filter[dim]?.includes(g)} aria-pressed={!!row.filter[dim]?.includes(g)}
							onclick={() => toggle(row.id, dim, g)}>{g}</button>
					{/each}
				</div>
			{/each}
		{/if}
		{#if stats[i]}{@render sliders(row.id, row.filter, stats[i], row.custom)}{/if}
	</div>
{/each}

{#if tab === CUSTOM}
	<button type="button" onclick={addCustom} disabled={customCount >= MAX_CUSTOM_SEGMENTS}>+ New custom group</button>
	<p class="muted small">
		Pick groups in any dimensions to target an intersection, e.g. 18-29 + Men = young men. Several
		picks in one dimension mean "or"; a dimension with nothing picked includes everyone.
	</p>
{:else}
	<p class="muted small">
		Vote: margin points toward D (+) or R (−). Turnout: % change in how many vote. Everything that
		applies to a voter stacks (e.g. Age 18-29 and Gender Men both apply to young men).
	</p>
{/if}
<!-- always laid out (disabled when idle) so it never pops in under a slider being dragged -->
<button type="button" class="link" disabled={!isActive(swing)} onclick={() => (swing = { segments: swing.segments.filter((g) => g.custom).map((g) => ({ ...g, vote: 0, turnout: 0 })) })}>reset all voter groups</button>

<style>
	.tabs {
		display: flex;
		gap: 4px;
		margin-bottom: 8px;
		flex-wrap: wrap;
	}
	.tabs button {
		padding: 3px 10px;
		font-size: 0.85rem;
	}
	.tabs button.active {
		background: var(--fg);
		color: var(--bg);
		border-color: var(--fg);
	}
	.dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		margin-left: 5px;
		vertical-align: middle;
	}
	.group {
		border-top: 1px solid var(--border);
		padding: 6px 0 4px;
	}
	.head {
		display: flex;
		gap: 8px;
		align-items: baseline;
		font-size: 0.9rem;
	}
	.x {
		margin: 0 0 0 auto;
	}
	.stat {
		display: flex;
		gap: 8px;
		font-size: 0.85rem;
		margin-top: 2px;
	}
	.dem {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		align-items: center;
		margin-top: 4px;
		font-size: 0.8rem;
	}
	.chips span {
		width: 72px;
	}
	.chips button {
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 0.8rem;
	}
	.chips button.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}
	/* The text column is wide enough for the longest reading ("Turnout −50% (100%)") and the
	   value sits in a fixed slot, so dragging a slider never re-wraps or shifts the panel. */
	label {
		display: grid;
		grid-template-columns: 11em minmax(0, 1fr);
		align-items: start;
		gap: 8px;
		font-size: 0.85rem;
		color: var(--muted);
		margin-top: 4px;
	}
	label > span {
		line-height: 20px; /* = the scrubber's bar row, so text lines up with the bar */
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	label b {
		color: var(--fg);
		display: inline-block;
		min-width: 3em;
		text-align: center;
	}
</style>
