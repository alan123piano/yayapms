<script lang="ts">
	import { decomposition, STAGE_LABELS, type RegionBasis } from './model';
	import { ratingText } from './shading';
	import type { Outcome, Party, Region } from './types';

	interface Props {
		region: Region;
		outcome: Outcome;
		/** pointer position (viewport px) */
		x: number;
		y: number;
		byId: Record<string, Party>;
		/** the region in the fitted model (real shares, and what each layer explains) */
		residual?: RegionBasis;
		/** the region in the baseline the simulation starts from */
		before?: RegionBasis;
		hasCells: boolean;
		/** short baseline name, e.g. "2024 President" */
		electionLabel: string;
	}
	let { region: r, outcome: o, x, y, byId, residual, before, hasCells, electionLabel }: Props = $props();

	let rows = $derived(
		Object.entries(o.shares ?? {})
			.filter(([, v]) => v > 0.0005)
			.sort((a, b) => b[1] - a[1])
	);
	/** the party whose share the decomposition explains: the district's real winner */
	let lead = $derived(residual ? Object.entries(residual.actual).sort((a, b) => b[1] - a[1])[0]?.[0] : undefined);
	const pct = (v: number | undefined) => (v === undefined ? '' : `${(v * 100).toFixed(1)}%`);
	const pts = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
</script>

<div class="tip" style:left="{x + 14}px" style:top="{y + 14}px">
	<b>{r.label}</b>
	{#if rows.length}
		<div class="shares">
			<span class="muted">{electionLabel}</span><span class="muted">now</span><span></span>
			{#each rows as [id, v] (id)}
				<span><span class="swatch sm" style:background={byId[id]?.color}></span>{byId[id]?.name ?? id}</span>
				<span class="num muted">{pct(before?.actual[id])}</span>
				<span class="num">{pct(v)}</span>
			{/each}
		</div>
	{/if}
	<div>{ratingText(o, byId)}{o.manual ? ' (manual)' : ''}</div>
	{#if r.seats !== 1}<div>{r.seats} seats</div>{/if}
	{#if hasCells && residual && lead}
		<div class="muted small parts">
			<span class="head">{byId[lead]?.name ?? lead}'s real share, explained:</span>
			{#each decomposition(residual, lead) as part, k (part.id)}
				<span>{part.id === 'unexplained' ? 'Unexplained' : STAGE_LABELS[part.id]}</span>
				<span class="num">{k ? pts(part.points) : `${part.points.toFixed(1)}%`}</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.tip {
		position: fixed;
		pointer-events: none;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 0.85rem;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.18);
		z-index: 10;
		max-width: 260px;
	}
	.parts,
	.shares {
		display: grid;
		column-gap: 10px;
		margin-top: 4px;
	}
	.parts {
		grid-template-columns: auto auto;
	}
	.shares {
		grid-template-columns: auto auto auto;
	}
	.parts .head {
		grid-column: 1 / -1;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
