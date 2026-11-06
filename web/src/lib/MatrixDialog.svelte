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

	/** each party gets the same columns; parties without a baseline (new ones) only have "now" */
	type Field = 'real' | 'add' | 'int' | 'now';
	const FIELDS: { id: Field; label: string; title: string }[] = [
		{ id: 'real', label: 'Real', title: 'Share in the real election, before any settings' },
		{ id: 'add', label: 'Main eff.', title: 'Share if age, race, education and gender combined independently' },
		{ id: 'int', label: 'Combined', title: 'Real minus main effects (points): how much this combination differs from its parts' },
		{ id: 'now', label: 'Now', title: 'Share after every setting in the sidebar' }
	];
	let inBaseline = $derived(new Set(sim.baselineParties));
	const fieldsOf = (id: string) => (inBaseline.has(id) ? FIELDS : FIELDS.filter((f) => f.id === 'now'));
	function field(g: GroupResult, id: string, f: Field): number | null {
		if (f === 'now') return g.shares[id] ?? 0;
		if (!inBaseline.has(id)) return null;
		const real = g.before.shares[id] ?? 0, add = g.additive[id] ?? 0;
		return f === 'real' ? real : f === 'add' ? add : real - add;
	}

	// ---------- sorting: by a dimension (its natural order), a stat, or a party's field ----------
	type SortKey = { kind: 'dim' | 'stat' | 'party'; id: string; f?: Field };
	let sort = $state<SortKey>({ kind: 'dim', id: '' });
	let desc = $state(false);
	const stat: Record<string, (g: GroupResult) => number> = {
		size: (g) => g.voterShare,
		turnout: (g) => g.turnout
	};
	function value(r: Row, k: SortKey): number {
		if (k.kind === 'dim') return cells.dims[k.id]?.indexOf(r.groups[k.id]) ?? 0;
		if (k.kind === 'stat') return stat[k.id](r.g);
		return field(r.g, k.id, k.f ?? 'now') ?? -Infinity;
	}
	let sorted = $derived(
		sort.id === '' ? rows : [...rows].sort((a, b) => (value(a, sort) - value(b, sort)) * (desc ? -1 : 1))
	);
	function sortBy(k: SortKey) {
		if (sort.kind === k.kind && sort.id === k.id && sort.f === k.f) desc = !desc;
		else { sort = k; desc = k.kind !== 'dim'; }
	}
	const ariaSort = (k: SortKey) =>
		sort.kind === k.kind && sort.id === k.id && sort.f === k.f ? (desc ? 'descending' : 'ascending') : 'none';

	function toggleDim(d: string) {
		folded = folded.includes(d) ? folded.filter((x) => x !== d) : [...folded, d];
		if (sort.kind === 'dim' && folded.includes(sort.id)) sort = { kind: 'dim', id: '' };
	}

	const pct = (x: number) => (x > 0 && x < 0.001 ? '<0.1' : (x * 100).toFixed(1));
	/** signed share points, e.g. "+4.2" */
	const pts = (x: number) => (Math.abs(x) < 0.0005 ? '0' : `${x > 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`);
	function cell(g: GroupResult, p: Party, f: Field): string {
		const v = field(g, p.id, f);
		return v === null ? '' : f === 'int' ? pts(v) : pct(v);
	}

	function download() {
		const dims = cells.order.filter((d) => by.includes(d));
		const head = [
			...dims.map((d) => DEMO_DIM_LABELS[d] ?? d), 'Share of voters', 'Turnout',
			...cols.flatMap((p) => fieldsOf(p.id).map((f) => `${p.name}: ${f.label}${f.id === 'int' ? ' (pts)' : ''}`))
		];
		const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
		const lines = [head, ...sorted.map((r) => [
			...dims.map((d) => r.groups[d]),
			r.g.voterShare.toFixed(6), r.g.turnout.toFixed(6),
			...cols.flatMap((p) => fieldsOf(p.id).map((f) => {
				const v = field(r.g, p.id, f.id) ?? 0;
				return f.id === 'int' ? (v * 100).toFixed(3) : v.toFixed(6);
			}))
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
					{#each by as d (d)}
						<th class="label" rowspan="2" aria-sort={ariaSort({ kind: 'dim', id: d })}>
							<button type="button" onclick={() => sortBy({ kind: 'dim', id: d })}>{DEMO_DIM_LABELS[d] ?? d}</button>
						</th>
					{/each}
					<th rowspan="2" aria-sort={ariaSort({ kind: 'stat', id: 'size' })}><button type="button" title="Share of all voters" onclick={() => sortBy({ kind: 'stat', id: 'size' })}>Size</button></th>
					<th rowspan="2" class="sep" aria-sort={ariaSort({ kind: 'stat', id: 'turnout' })}><button type="button" title="Voters / citizens of voting age" onclick={() => sortBy({ kind: 'stat', id: 'turnout' })}>Turnout</button></th>
					{#each cols as p (p.id)}
						<th class="party sep" colspan={fieldsOf(p.id).length}><span class="swatch sm" style:background={p.color}></span>{p.name}</th>
					{/each}
				</tr>
				<tr>
					{#each cols as p (p.id)}
						{#each fieldsOf(p.id) as f, k (f.id)}
							<th class:sep={k === fieldsOf(p.id).length - 1} aria-sort={ariaSort({ kind: 'party', id: p.id, f: f.id })}>
								<button type="button" title={f.title} onclick={() => sortBy({ kind: 'party', id: p.id, f: f.id })}>{f.label}</button>
							</th>
						{/each}
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each sorted as r (r.key)}
					<tr>
						{#each by as d (d)}<th class="label">{r.groups[d]}</th>{/each}
						<td class="muted">{pct(r.g.voterShare)}</td>
						<td class="muted sep">{pct(r.g.turnout)}</td>
						{#each cols as p (p.id)}
							{#each fieldsOf(p.id) as f, k (f.id)}
								{@const v = field(r.g, p.id, f.id) ?? 0}
								<td
									class:sep={k === fieldsOf(p.id).length - 1}
									class:muted={f.id === 'real' || f.id === 'add'}
									class:target={f.id === 'now' && targeted.has(`${p.id}|${r.key}`)}
									style:background={f.id === 'now' ? `color-mix(in oklab, ${p.color} ${Math.round(v * 55)}%, transparent)` : undefined}
									style:color={f.id === 'int' && v > 0.0005 ? p.color : undefined}
								>{cell(r.g, p, f.id)}</td>
							{/each}
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="hint">
		Every party gets the same columns, in % of the group's votes. <b>Real</b>: its share in the real
		election, before any settings. <b>Main eff.</b>: its share if age, race, education and gender
		combined independently (a multinomial logit with one term per group and party, fitted to every
		single group's national total). <b>Combined</b>: real minus main effects, in points, i.e. how
		much this combination differs from the sum of its parts. <b>Now</b>: after every setting in
		the sidebar; underlined where the party targets that group. New parties have no real result,
		so they only have Now.
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
	thead {
		position: sticky;
		top: 0;
		z-index: 1;
	}
	thead th {
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}
	thead th.party {
		text-align: center;
		font-size: 0.8rem;
	}
	thead th.party .swatch {
		margin-right: 4px;
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
