<script lang="ts">
	import { DEMO_DIM_LABELS } from './config';
	import { filterKey, type Filter } from './demographics';
	import { isLive, type GroupResult, type Simulation } from './model';
	import { spectrumOrder } from './parties';
	import type { CellData, Party } from './types';

	interface Props {
		sim: Simulation;
		parties: Party[];
		cells: CellData;
		/** e.g. "2024 President (demographics only)" */
		baselineLabel: string;
		onclose: () => void;
	}
	let { sim, parties, cells, baselineLabel, onclose }: Props = $props();

	let dialog: HTMLDialogElement;
	$effect(() => {
		dialog.showModal();
	});

	/** dimensions folded together (not broken down); none = every cell */
	let folded = $state<string[]>([]);
	let by = $derived(cells.order.filter((d) => !folded.includes(d)));
	let cols = $derived(spectrumOrder(parties.filter(isLive)));
	let targeted = $derived(new Set(parties.flatMap((p) => p.appeals.map((a) => `${p.id}|${filterKey(a.filter)}`))));

	interface Row { key: string; groups: Record<string, string>; g: GroupResult }
	let rows = $derived.by((): Row[] => {
		const dims = cells.order.filter((d) => by.includes(d));
		let combos: Record<string, string>[] = [{}];
		for (const d of dims) combos = combos.flatMap((c) => cells.dims[d].map((g) => ({ ...c, [d]: g })));
		return combos.map((c) => {
			const f: Filter = Object.fromEntries(Object.entries(c).map(([d, g]) => [d, [g]]));
			return { key: filterKey(f), groups: c, g: sim.group(f) };
		});
	});

	// ---------- sorting: by a dimension (its natural order), a stat, or a party ----------
	type SortKey = { kind: 'dim' | 'stat' | 'party'; id: string };
	let sort = $state<SortKey>({ kind: 'dim', id: '' });
	let desc = $state(false);
	const stat: Record<string, (g: GroupResult) => number> = {
		size: (g) => g.voterShare,
		turnout: (g) => g.turnout,
		base: (g) => g.before.dem,
		add: (g) => g.additive,
		int: (g) => g.before.dem - g.additive
	};
	function value(r: Row, k: SortKey): number {
		if (k.kind === 'dim') return cells.dims[k.id]?.indexOf(r.groups[k.id]) ?? 0;
		if (k.kind === 'stat') return stat[k.id](r.g);
		return r.g.shares[k.id] ?? 0;
	}
	let sorted = $derived(
		sort.id === '' ? rows : [...rows].sort((a, b) => (value(a, sort) - value(b, sort)) * (desc ? -1 : 1))
	);
	function sortBy(k: SortKey) {
		if (sort.kind === k.kind && sort.id === k.id) desc = !desc;
		else { sort = k; desc = k.kind !== 'dim'; }
	}
	const ariaSort = (k: SortKey) => (sort.kind === k.kind && sort.id === k.id ? (desc ? 'descending' : 'ascending') : 'none');

	function toggleDim(d: string) {
		folded = folded.includes(d) ? folded.filter((x) => x !== d) : [...folded, d];
		if (sort.kind === 'dim' && folded.includes(sort.id)) sort = { kind: 'dim', id: '' };
	}

	const pct = (x: number) => (x > 0 && x < 0.001 ? '<0.1' : (x * 100).toFixed(1));
	const leanColor = (x: number) =>
		Math.abs(x) < 0.00025 ? undefined : parties.find((p) => p.id === (x > 0 ? 'D' : 'R'))?.color;
	/** signed margin points, e.g. "D+4.2" */
	const pts = (x: number) => {
		const m = x * 200;
		return Math.abs(m) < 0.05 ? '0' : `${m > 0 ? 'D' : 'R'}+${Math.abs(m).toFixed(1)}`;
	};

	function download() {
		const dims = cells.order.filter((d) => by.includes(d));
		const head = [...dims.map((d) => DEMO_DIM_LABELS[d] ?? d), 'Share of voters', 'Turnout', 'Real D (two-party)', 'Main effects only D', 'Combined effect (D margin pts)', ...cols.map((p) => p.name)];
		const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
		const lines = [head, ...sorted.map((r) => [
			...dims.map((d) => r.groups[d]),
			r.g.voterShare.toFixed(6), r.g.turnout.toFixed(6), r.g.before.dem.toFixed(6), r.g.additive.toFixed(6),
			((r.g.before.dem - r.g.additive) * 200).toFixed(3),
			...cols.map((p) => (r.g.shares[p.id] ?? 0).toFixed(6))
		])].map((l) => l.map(esc).join(','));
		const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = 'vote-by-group.csv';
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<dialog bind:this={dialog} {onclose}>
	<div class="top">
		<h2>Vote by group: full table</h2>
		<button type="button" onclick={() => dialog.close()} aria-label="Close">×</button>
	</div>
	<p class="hint">
		Baseline: {baselineLabel}, plus every setting in the sidebar. National totals. Click a column to sort.
	</p>
	<div class="controls">
		<span class="muted small">Break down by</span>
		{#each cells.order as d (d)}
			<button type="button" class="chip" class:on={by.includes(d)} aria-pressed={by.includes(d)} onclick={() => toggleDim(d)}>
				{DEMO_DIM_LABELS[d] ?? d}
			</button>
		{/each}
		<span class="muted small count">{rows.length} {rows.length === 1 ? 'group' : 'groups'}</span>
		<button type="button" onclick={download}>Download CSV</button>
	</div>

	<div class="scroll">
		<table>
			<thead>
				<tr>
					{#each cells.order.filter((d) => by.includes(d)) as d (d)}
						<th class="label" aria-sort={ariaSort({ kind: 'dim', id: d })}>
							<button type="button" onclick={() => sortBy({ kind: 'dim', id: d })}>{DEMO_DIM_LABELS[d] ?? d}</button>
						</th>
					{/each}
					<th aria-sort={ariaSort({ kind: 'stat', id: 'size' })}><button type="button" title="Share of all voters" onclick={() => sortBy({ kind: 'stat', id: 'size' })}>Size</button></th>
					<th aria-sort={ariaSort({ kind: 'stat', id: 'turnout' })}><button type="button" title="Voters / citizens of voting age" onclick={() => sortBy({ kind: 'stat', id: 'turnout' })}>Turnout</button></th>
					<th aria-sort={ariaSort({ kind: 'stat', id: 'base' })}><button type="button" title="Two-party D share in the real election" onclick={() => sortBy({ kind: 'stat', id: 'base' })}>Real D</button></th>
					<th aria-sort={ariaSort({ kind: 'stat', id: 'add' })}><button type="button" title="Two-party D share if age, race, education and gender combined independently" onclick={() => sortBy({ kind: 'stat', id: 'add' })}>Main effects</button></th>
					<th class="sep" aria-sort={ariaSort({ kind: 'stat', id: 'int' })}><button type="button" title="Real minus main effects: how much this combination differs from its parts" onclick={() => sortBy({ kind: 'stat', id: 'int' })}>Combined</button></th>
					{#each cols as p (p.id)}
						<th aria-sort={ariaSort({ kind: 'party', id: p.id })}>
							<button type="button" title={p.name} onclick={() => sortBy({ kind: 'party', id: p.id })}>
								<span class="swatch sm" style:background={p.color}></span>{p.name}
							</button>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each sorted as r (r.key)}
					<tr>
						{#each cells.order.filter((d) => by.includes(d)) as d (d)}<th class="label">{r.groups[d]}</th>{/each}
						<td class="muted">{pct(r.g.voterShare)}</td>
						<td class="muted">{pct(r.g.turnout)}</td>
						<td class="muted">{pct(r.g.before.dem)}</td>
						<td class="muted">{pct(r.g.additive)}</td>
						<td class="sep" style:color={leanColor(r.g.before.dem - r.g.additive)}>{pts(r.g.before.dem - r.g.additive)}</td>
						{#each cols as p (p.id)}
							{@const v = r.g.shares[p.id] ?? 0}
							<td
								class:target={targeted.has(`${p.id}|${r.key}`)}
								style:background="color-mix(in oklab, {p.color} {Math.round(v * 55)}%, transparent)"
							>{pct(v)}</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="hint">
		Size, turnout and party shares are in %. <b>Real D</b> is the group's two-party Democratic share
		in the real election, before any settings. <b>Main effects</b> is what it would be if age, race,
		education and gender combined independently: a logit with one term per group, fitted to every
		single group's national total. <b>Combined</b> is the difference, i.e. how much this combination
		differs from the sum of its parts. Underlined: a party's target group.
	</p>
	<p class="hint">
		Where the numbers come from: who lives in each district (Census ACS) is estimated per tract. How
		each cell votes comes from the Cooperative Election Study (CES) survey, modeled with every main
		effect and every <i>pairwise</i> interaction (age × race, race × education, ...), plus region and
		state effects, then calibrated so each tract matches its real result. Three- and four-way
		interactions (e.g. young + Hispanic + college + men beyond its pairs) are not modeled.
	</p>
</dialog>

<style>
	dialog {
		background: var(--surface);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 10px;
		width: min(1100px, calc(100vw - 32px));
		max-height: calc(100dvh - 32px);
		padding: 16px 20px;
		display: flex;
		flex-direction: column;
	}
	dialog:not([open]) {
		display: none;
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.45);
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.top button {
		border: none;
		background: none;
		font-size: 1.4rem;
		line-height: 1;
		padding: 2px 8px;
	}
	h2 {
		margin: 0;
		font-size: 1.1rem;
	}
	.hint {
		color: var(--muted);
		font-size: 0.85rem;
		margin: 4px 0 10px;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-bottom: 10px;
	}
	.chip {
		padding: 2px 10px;
		border-radius: 999px;
		font-size: 0.85rem;
	}
	.chip.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}
	.count {
		margin-left: auto;
	}
	.scroll {
		overflow: auto;
		min-height: 0;
		flex: 1;
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}
	th,
	td {
		padding: 3px 8px;
		text-align: right;
		font-weight: normal;
		white-space: nowrap;
	}
	.label {
		text-align: left;
	}
	thead th {
		position: sticky;
		top: 0;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		z-index: 1;
	}
	thead button {
		border: none;
		background: none;
		padding: 2px 0;
		font-size: 0.8rem;
		color: var(--muted);
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	thead th[aria-sort='ascending'] button::after {
		content: '▲';
		font-size: 0.6rem;
	}
	thead th[aria-sort='descending'] button::after {
		content: '▼';
		font-size: 0.6rem;
	}
	thead th[aria-sort='ascending'] button,
	thead th[aria-sort='descending'] button {
		color: var(--fg);
	}
	tbody tr:hover th,
	tbody tr:hover td {
		box-shadow: inset 0 0 0 9999px color-mix(in srgb, var(--fg) 6%, transparent);
	}
	.sep {
		border-right: 1px solid var(--border);
	}
	td.target {
		font-weight: 600;
		text-decoration: underline;
		text-decoration-color: var(--accent);
		text-underline-offset: 2px;
	}
</style>
