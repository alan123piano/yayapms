<script lang="ts">
	import { DEMO_DIM_LABELS, DEMO_LIMITS } from './config';
	import { emptySwing, groupStats, isActive, type DemoSwing } from './demographics';
	import { swingLabel } from './format';
	import type { CellData, Region } from './types';

	interface Props {
		/** regions of the current map (for the electorate summary) */
		regions: Region[];
		cells: CellData;
		swing: DemoSwing;
	}
	let { regions, cells, swing = $bindable() }: Props = $props();

	let picked = $state<string | null>(null);
	let dim = $derived(picked && cells.order.includes(picked) ? picked : cells.order[0]);
	let stats = $derived(groupStats(regions, cells, dim, swing));
	const pct = (x: number) => `${Math.round(x * 100)}%`;

	function set(kind: 'vote' | 'turnout', g: string, v: number) {
		const next = { ...swing[kind], [dim]: { ...(swing[kind][dim] ?? {}), [g]: v } };
		swing = { ...swing, [kind]: next };
	}
	const val = (kind: 'vote' | 'turnout', g: string) => swing[kind][dim]?.[g] ?? 0;
	const changed = (d: string) =>
		Object.values(swing.vote[d] ?? {}).some((v) => v) || Object.values(swing.turnout[d] ?? {}).some((v) => v);
</script>

<div class="tabs" role="tablist" aria-label="Voter group dimension">
	{#each cells.order as d (d)}
		<button type="button" role="tab" aria-selected={dim === d} class:active={dim === d} onclick={() => (picked = d)}>
			{DEMO_DIM_LABELS[d] ?? d}{#if changed(d)}<span class="dot" aria-label="(changed)"></span>{/if}
		</button>
	{/each}
</div>

{#each stats as s (s.group)}
	{@const v = val('vote', s.group)}
	{@const t = val('turnout', s.group)}
	<div class="group">
		<div class="head">
			<b>{s.group}</b>
			<span class="muted">{pct(s.voterShare)} of voters</span>
			<span class="dem">
				D {pct(s.demBefore)}{#if v || t}<span class="muted"> → </span>{pct(s.demAfter)}{/if}
			</span>
		</div>
		<label>
			<span>Vote <b>{v ? swingLabel(v) : '—'}</b></span>
			<input type="range" min={-DEMO_LIMITS.vote} max={DEMO_LIMITS.vote} step="1" value={v}
				oninput={(e) => set('vote', s.group, Number(e.currentTarget.value))} />
		</label>
		<label>
			<span>Turnout <b>{t ? `${t > 0 ? '+' : ''}${t}%` : '—'}</b> <span class="muted">({pct(s.turnoutAfter)})</span></span>
			<input type="range" min={-DEMO_LIMITS.turnout} max={DEMO_LIMITS.turnout} step="5" value={t}
				oninput={(e) => set('turnout', s.group, Number(e.currentTarget.value))} />
		</label>
	</div>
{/each}

{#if isActive(swing)}
	<button type="button" class="link" onclick={() => (swing = emptySwing())}>reset voter groups</button>
{/if}
<p class="muted small">
	Vote: margin points toward D (+) or R (−) for that group's voters. Turnout: % change in how many of
	them vote. Settings on different tabs stack (e.g. Age 18-29 and Gender Men both apply to young men).
</p>

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
		position: relative;
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
	.dem {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}
	label {
		display: grid;
		grid-template-columns: 112px 1fr;
		align-items: center;
		gap: 8px;
		font-size: 0.85rem;
		color: var(--muted);
		margin-top: 4px;
	}
	label b {
		color: var(--fg);
	}
</style>
