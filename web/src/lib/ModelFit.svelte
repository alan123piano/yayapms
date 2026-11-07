<script lang="ts">
	import { STAGE_LABELS, type BasisFit } from './model';
	import type { Party } from './types';

	interface Props {
		fit: BasisFit;
		parties: Party[];
	}
	let { fit, parties }: Props = $props();

	const colorOf = (id: string) => parties.find((p) => p.id === id)?.color;
	const nameOf = (id: string) => parties.find((p) => p.id === id)?.name ?? id;
	/** each factor's strongest effect: the party it helps most, in points of vote share */
	let effects = $derived(
		(fit.local?.effects ?? [])
			.map((e) => {
				const [party, points] = Object.entries(e.byParty).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
				return { ...e, party, points };
			})
			.sort((a, b) => b.points - a.points)
			.slice(0, 8)
	);
	let maxEffect = $derived(Math.max(0.5, ...effects.map((e) => e.points)));
</script>

<p class="muted small">
	How far districts' real results still are from what the layers explain (points of vote share,
	typical district and party):
</p>
<table>
	<tbody>
		{#each fit.spread as s (s.id)}
			<tr>
				<th>+ {STAGE_LABELS[s.id]}</th>
				<td>{s.points.toFixed(1)} pts left</td>
			</tr>
		{/each}
	</tbody>
</table>
{#if fit.local}
	<p class="muted small">
		Local factors explain {Math.round(fit.local.r2 * 100)}% of the gap between districts of the same
		state (cross-validated). Strongest, per standard deviation of the factor within a state, with the
		party it helps:
	</p>
	<ul class="effects">
		{#each effects as e (e.id)}
			<li>
				<span class="label" title={e.label}>{e.label}</span>
				<span class="bar"><span style:width="{(e.points / maxEffect) * 100}%" style:background={colorOf(e.party)}></span></span>
				<span class="num" title={nameOf(e.party)}>+{e.points.toFixed(1)}</span>
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
