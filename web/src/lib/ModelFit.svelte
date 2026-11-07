<script lang="ts">
	import { STAGE_LABELS, type BasisFit } from './model';
	import type { Party } from './types';

	interface Props {
		fit: BasisFit;
		parties: Party[];
	}
	let { fit, parties }: Props = $props();

	let dColor = $derived(parties.find((p) => p.id === 'D')?.color);
	let rColor = $derived(parties.find((p) => p.id === 'R')?.color);
	/** the strongest local factors, by size of effect */
	let effects = $derived([...(fit.local?.effects ?? [])].sort((a, b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, 8));
	let maxEffect = $derived(Math.max(1, ...effects.map((e) => Math.abs(e.points))));
	const fmt = (x: number) => `${x > 0 ? 'D' : 'R'}+${Math.abs(x).toFixed(1)}`;
</script>

<p class="muted small">
	How far districts' real results are from what each layer explains (spread of the D–R margin
	gap across districts, vote-weighted):
</p>
<table>
	<tbody>
		{#each fit.spread as s (s.id)}
			<tr>
				<th>+ {s.id === 'unexplained' ? '' : STAGE_LABELS[s.id]}</th>
				<td>{s.points.toFixed(1)} pts left</td>
			</tr>
		{/each}
	</tbody>
</table>
{#if fit.local}
	<p class="muted small">
		Local factors explain {Math.round(fit.local.r2 * 100)}% of the gap between districts of the same
		state (cross-validated). Strongest, per standard deviation of the factor within a state:
	</p>
	<ul class="effects">
		{#each effects as e (e.id)}
			<li>
				<span class="label" title={e.label}>{e.label}</span>
				<span class="bar"><span style:width="{(Math.abs(e.points) / maxEffect) * 100}%" style:background={e.points > 0 ? dColor : rColor}></span></span>
				<span class="num">{fmt(e.points)}</span>
			</li>
		{/each}
	</ul>
{/if}
{#if fit.neighbors}
	<p class="muted small">
		What's left is shared with neighboring districts at a weight of {fit.neighbors.weight.toFixed(2)}
		(0 = unrelated, 1 = identical).
	</p>
{/if}

<style>
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	th {
		text-align: left;
		font-weight: normal;
		color: var(--muted);
		padding: 2px 0;
	}
	td {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.effects {
		list-style: none;
		padding: 0;
		margin: 4px 0;
		font-size: 0.8rem;
	}
	.effects li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 70px 48px;
		gap: 6px;
		align-items: center;
		padding: 1px 0;
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.bar {
		height: 6px;
		background: var(--border);
		border-radius: 3px;
		overflow: hidden;
	}
	.bar span {
		display: block;
		height: 100%;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
