<script lang="ts">
	import { DEMO_DIM_LABELS } from './config';
	import { filterKey, type Filter, type GroupOption } from './demographics';
	import { isLive, type Simulation } from './model';
	import { spectrumOrder } from './parties';
	import type { CellData, Party } from './types';

	interface Props {
		/** the current scenario on the current map */
		sim: Simulation;
		parties: Party[];
		cells: CellData;
		/** custom voter groups, shown after the single groups */
		custom: GroupOption[];
	}
	let { sim, parties, cells, custom }: Props = $props();

	let cols = $derived(spectrumOrder(parties.filter(isLive)));
	/** "party|filterKey" for every target, so targeted cells can be marked */
	let targeted = $derived(new Set(parties.flatMap((p) => p.appeals.map((a) => `${p.id}|${filterKey(a.filter)}`))));

	type Row = { key: string; label: string; filter: Filter };
	let sections = $derived<{ title: string; rows: Row[] }[]>([
		{ title: '', rows: [{ key: '', label: 'Everyone', filter: {} }] },
		...cells.order.map((dim) => ({
			title: DEMO_DIM_LABELS[dim] ?? dim,
			rows: cells.dims[dim].map((g) => {
				const filter = { [dim]: [g] };
				return { key: filterKey(filter), label: g, filter };
			})
		})),
		...(custom.length ? [{ title: 'Custom', rows: custom.map((c) => ({ key: c.key, label: c.label, filter: c.filter })) }] : [])
	]);
	let results = $derived(new Map(sections.flatMap((s) => s.rows).map((r) => [r.key, sim.group(r.filter)])));
	const pct = (x: number | undefined) => (x === undefined ? '' : `${Math.round(x * 100)}`);
</script>

<div class="wrap">
	<table>
		<thead>
			<tr>
				<th class="label">Group</th>
				<th class="muted" title="Share of all voters">Size</th>
				{#each cols as p (p.id)}<th title={p.name}><span class="swatch sm" style:background={p.color}></span></th>{/each}
			</tr>
		</thead>
		{#each sections as s (s.title)}
			<tbody>
				{#if s.title}<tr class="section"><th colspan={cols.length + 2}>{s.title}</th></tr>{/if}
				{#each s.rows as r (r.key)}
					{@const g = results.get(r.key)}
					<tr>
						<th class="label" title={r.label}>{r.label}</th>
						<td class="muted">{pct(g?.voterShare)}</td>
						{#each cols as p (p.id)}
							<td class:target={targeted.has(`${p.id}|${r.key}`)} title={targeted.has(`${p.id}|${r.key}`) ? `${p.name} targets this group` : undefined}>{pct(g?.shares[p.id])}</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		{/each}
	</table>
</div>
<p class="muted small">
	% of each group's votes won by each party, nationally, after every setting above. Underlined:
	a party's target group.
</p>
<!-- space kept so the note can't shift the panel mid-drag -->
<p class="warn small" class:hidden={sim.converged} aria-hidden={sim.converged}>
	Some targets can't all be met at once; these are the closest the model gets.
</p>

<style>
	.wrap {
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
	}
	th,
	td {
		padding: 2px 4px;
		text-align: right;
		font-weight: normal;
	}
	thead th {
		color: var(--muted);
		text-align: center;
	}
	.label {
		text-align: left;
		max-width: 110px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	tbody tr:not(.section):hover {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}
	.section th {
		text-align: left;
		color: var(--muted);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding-top: 8px;
	}
	.warn {
		color: var(--danger);
		margin-top: 0;
	}
	.hidden {
		visibility: hidden;
	}
	td.target {
		font-weight: 600;
		text-decoration: underline;
		text-decoration-color: var(--accent);
		text-underline-offset: 2px;
	}
</style>
