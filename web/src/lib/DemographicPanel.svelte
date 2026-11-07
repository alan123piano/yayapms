<script lang="ts">
	import { DEMO_DIM_LABELS, DEMO_LIMITS } from './config';
	import { describe, filterKey, isActive, MAX_CUSTOM_SEGMENTS, type DemoSwing, type Filter, type Segment } from './demographics';
	import { isLive, type Simulation } from './model';
	import { spectrumOrder } from './parties';
	import Scrubber, { stepped } from './Scrubber.svelte';
	import type { CellData, Party } from './types';

	interface Props {
		/** the current scenario on the current map (for the electorate summary) */
		sim: Simulation;
		cells: CellData;
		/** voter groups: turnout changes and the custom groups */
		swing: DemoSwing;
		/** parties: their appeals per group are edited here */
		parties: Party[];
		/** "fit to…": set party's appeal in a group so it wins `target` (0..1) of it; returns
		 *  false if that is out of reach */
		onfit: (partyId: string, filter: Filter, target: number) => boolean;
	}
	let { sim, cells, swing = $bindable(), parties = $bindable(), onfit }: Props = $props();

	const ALL = 'all';
	const CUSTOM = 'custom';
	const APPEAL = { stops: stepped(-DEMO_LIMITS.appeal, DEMO_LIMITS.appeal, 1), every: 5 };
	const TURNOUT = { stops: stepped(-DEMO_LIMITS.turnout, DEMO_LIMITS.turnout, 5), every: 5 };
	const fmtSigned = (unit: string) => (t: number) => (t ? `${t > 0 ? '+' : '−'}${Math.abs(t)}${unit}` : '0');
	const fmtPts = fmtSigned('');
	const fmtTurnout = fmtSigned('%');
	let picked = $state<string | null>(null);
	let tabs = $derived([ALL, ...cells.order, CUSTOM]);
	let tab = $derived(picked && tabs.includes(picked) ? picked : cells.order[0]);
	let live = $derived(spectrumOrder(parties.filter(isLive)));

	interface Row { id: string; filter: Filter; title: string; custom: boolean }
	/** rows shown on the current tab: everyone, one per group of the dimension, or the custom groups */
	let rows = $derived.by((): Row[] => {
		if (tab === ALL) return [{ id: ALL, filter: {}, title: 'Everyone', custom: false }];
		if (tab === CUSTOM) {
			return swing.segments
				.filter((g) => g.custom)
				.map((g) => ({ id: g.id, filter: g.filter, title: describe(g.filter, cells.order), custom: true }));
		}
		return cells.dims[tab].map((g) => ({ id: `${tab}=${g}`, filter: { [tab]: [g] }, title: g, custom: false }));
	});
	let stats = $derived(rows.map((r) => sim.group(r.filter)));
	let customCount = $derived(swing.segments.filter((g) => g.custom).length);
	const pct = (x: number | undefined) => `${Math.round((x ?? 0) * 100)}%`;

	// ---------- appeals (stored on the parties) ----------
	const appealOf = (p: Party, f: Filter) => p.appeals.find((a) => filterKey(a.filter) === filterKey(f))?.points ?? 0;
	function setAppeal(p: Party, f: Filter, points: number) {
		const key = filterKey(f);
		const rest = p.appeals.filter((a) => filterKey(a.filter) !== key);
		// zero appeals are dropped so share links stay short
		p.appeals = points ? [...rest, { filter: structuredClone($state.snapshot(f)), points }] : rest;
	}
	let anyAppeal = $derived(parties.some((p) => p.appeals.some((a) => a.points)));

	// ---------- fit to a share ----------
	let fitting = $state<{ key: string; value: string; failed: boolean } | null>(null);
	function submitFit(p: Party, f: Filter) {
		const v = Number(fitting?.value);
		if (!fitting || !Number.isFinite(v)) return;
		const ok = onfit(p.id, f, Math.min(100, Math.max(0, v)) / 100);
		fitting = ok ? null : { ...fitting, failed: true };
	}

	// ---------- turnout + custom groups (the segments) ----------
	const seg = (id: string) => swing.segments.find((g) => g.id === id);
	function update(id: string, filter: Filter, patch: Partial<Segment>, custom = false) {
		const cur = seg(id) ?? { id, filter, turnout: 0, custom: custom || undefined };
		const next = { ...cur, ...patch };
		const rest = swing.segments.filter((g) => g.id !== id);
		// drop untouched single-group segments so share links stay short
		swing = { segments: !next.custom && !next.turnout ? rest : [...rest, next] };
	}
	function addCustom() {
		let n = 1;
		while (seg(`c${n}`)) n++;
		update(`c${n}`, {}, {}, true);
	}
	function removeCustom(id: string) {
		const f = seg(id)?.filter;
		swing = { segments: swing.segments.filter((g) => g.id !== id) };
		// its appeals go with it
		if (f) for (const p of parties) setAppeal(p, f, 0);
	}
	function toggle(id: string, dim: string, group: string) {
		const old = seg(id)?.filter ?? {};
		const f = { ...old };
		const cur = f[dim] ?? [];
		f[dim] = cur.includes(group) ? cur.filter((x) => x !== group) : [...cur, group];
		if (!f[dim].length) delete f[dim];
		update(id, f, { filter: f });
		// appeals follow the group's new definition
		for (const p of parties) {
			const v = appealOf(p, old);
			if (v) { setAppeal(p, old, 0); setAppeal(p, f, v); }
		}
	}
	function resetAll() {
		swing = { segments: swing.segments.filter((g) => g.custom).map((g) => ({ ...g, turnout: 0 })) };
		for (const p of parties) p.appeals = [];
	}
	const inTab = (t: string, f: Filter) => {
		const k = filterKey(f);
		if (t === ALL) return k === '';
		if (t === CUSTOM) return swing.segments.some((g) => g.custom && filterKey(g.filter) === k);
		return Object.keys(f).length === 1 && f[t]?.length === 1;
	};
	const changed = (t: string) =>
		parties.some((p) => p.appeals.some((a) => a.points && inTab(t, a.filter))) ||
		swing.segments.some((g) => g.turnout && inTab(t, g.filter));
</script>

{#snippet sliders(row: Row, g: ReturnType<Simulation['group']>)}
	{@const t = seg(row.id)?.turnout ?? 0}
	<div class="stat">
		<span class="muted">{pct(g.voterShare)} of voters</span>
		<span class="now">
			{#each live as p (p.id)}
				<button type="button" class="share" title="{p.name}: {pct(g.shares[p.id])} of {row.title}. Click to fit its appeal to a share."
					onclick={() => (fitting = { key: `${p.id}|${row.id}`, value: String(Math.round((g.shares[p.id] ?? 0) * 100)), failed: false })}>
					<span class="swatch sm" style:background={p.color}></span>{pct(g.shares[p.id])}
				</button>
			{/each}
		</span>
	</div>
	{#each live as p (p.id)}
		{@const v = appealOf(p, row.filter)}
		{@const key = `${p.id}|${row.id}`}
		<label>
			<span class="name" title="{p.name}: appeal in points of its share of this group, at the baseline">
				<span class="swatch sm" style:background={p.color}></span>{p.name} <b>{v ? fmtPts(v) : '—'}</b>
			</span>
			<Scrubber value={v} stops={APPEAL.stops} ticks={APPEAL.stops.filter((x) => x % APPEAL.every === 0)}
				labels={[-25, 0, 25]} format={fmtPts} origin={0} aria-label="{p.name} appeal among {row.title}"
				onchange={(x) => setAppeal(p, row.filter, x)} />
		</label>
		{#if fitting?.key === key}
			<form class="fit" onsubmit={(e) => { e.preventDefault(); submitFit(p, row.filter); }}>
				<span class="muted">Fit {p.name} to</span>
				<input type="number" min="0" max="100" step="1" bind:value={fitting.value} aria-label="Target share (%)" />
				<span class="muted">% of {row.title}</span>
				<button type="submit">Fit</button>
				<button type="button" class="link" onclick={() => (fitting = null)}>cancel</button>
				{#if fitting.failed}<span class="error">out of reach</span>{/if}
			</form>
		{/if}
	{/each}
	<label>
		<span class="name">Turnout <b>{t ? fmtTurnout(t) : '—'}</b> <span class="muted">({pct(g.turnout)})</span></span>
		<Scrubber value={t} stops={TURNOUT.stops} labels={[-DEMO_LIMITS.turnout / 2, 0, DEMO_LIMITS.turnout / 2]}
			format={fmtTurnout} origin={0} aria-label="Turnout change among {row.title}"
			onchange={(x) => update(row.id, row.filter, { turnout: x }, row.custom)} />
	</label>
{/snippet}

<div class="tabs" role="tablist" aria-label="Voter groups">
	{#each tabs as d (d)}
		<button type="button" role="tab" aria-selected={tab === d} class:active={tab === d} onclick={() => (picked = d)}>
			{d === CUSTOM ? 'Custom' : d === ALL ? 'Everyone' : (DEMO_DIM_LABELS[d] ?? d)}{#if changed(d)}<span class="dot" aria-label="(changed)"></span>{/if}
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
		{#if stats[i]}{@render sliders(row, stats[i])}{/if}
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
		Each party's appeal is in points of its share of the group at the baseline: +5 is what would
		take it 5 points higher there if nothing else changed. Appeals add up for every group a voter
		is in (18-29 and Men both apply to young men), so any combination works. Turnout: % change in
		how many vote. Click a party's share above its sliders to fit its appeal to a share you type.
	</p>
{/if}
<!-- always laid out (disabled when idle) so it never pops in under a slider being dragged -->
<button type="button" class="link" disabled={!isActive(swing) && !anyAppeal} onclick={resetAll}>reset all voter groups</button>

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
	.now {
		margin-left: auto;
		display: flex;
		gap: 8px;
		font-variant-numeric: tabular-nums;
	}
	.now .share {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		border: none;
		background: none;
		padding: 0;
		font-size: inherit;
		border-bottom: 1px dotted var(--muted);
		border-radius: 0;
	}
	.now .share:hover {
		color: var(--accent);
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.name .swatch {
		margin-right: 4px;
		vertical-align: middle;
	}
	.fit {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		font-size: 0.8rem;
		margin: 2px 0 4px;
	}
	.fit input {
		width: 4.5em;
		padding: 1px 4px;
	}
	.fit button[type='submit'] {
		padding: 1px 8px;
		font-size: 0.8rem;
	}
	.fit .link {
		font-size: 0.8rem;
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
