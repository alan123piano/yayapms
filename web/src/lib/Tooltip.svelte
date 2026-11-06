<script lang="ts">
	import { fmtMargin } from './format';
	import { ratingText } from './shading';
	import { residualPoints, twoPartyD, type RegionBasis } from './model';
	import { margin } from './sim';
	import type { Outcome, Party, Region } from './types';

	interface Props {
		region: Region;
		outcome: Outcome;
		/** pointer position (viewport px) */
		x: number;
		y: number;
		byId: Record<string, Party>;
		/** the region in the fitted model (for its demographic expectation and residual) */
		residual?: RegionBasis;
		hasCells: boolean;
		/** short election name shown before the margin, e.g. "2024 President" */
		electionLabel: string;
	}
	let { region: r, outcome: o, x, y, byId, residual, hasCells, electionLabel }: Props = $props();

	let twoParty = $derived(Object.keys(byId).length === 2);
	let real = $derived(r.demShare !== null ? fmtMargin(margin(r.demShare, 0)) : '');
	/** the simulated two-party result, if anything moved it */
	let now = $derived(o.shares && o.shares.D + o.shares.R > 0 ? fmtMargin(margin(o.shares.D / (o.shares.D + o.shares.R), 0)) : real);
</script>

<div class="tip" style:left="{x + 14}px" style:top="{y + 14}px">
	<b>{r.label}</b>
	{#if o.shares}
		{#if twoParty && r.demShare !== null}
			<div>{electionLabel}: {real}{now !== real ? ` → ${now}` : ''}</div>
		{:else}
			{#each Object.entries(o.shares).sort((a, b) => b[1] - a[1]) as [id, v] (id)}
				<div class="share"><span class="swatch sm" style:background={byId[id]?.color}></span>{byId[id]?.name ?? id}<span>{(v * 100).toFixed(1)}%</span></div>
			{/each}
		{/if}
	{/if}
	<div>{ratingText(o, byId)}{o.manual ? ' (manual)' : ''}</div>
	{#if r.seats !== 1}<div>{r.seats} seats</div>{/if}
	{#if hasCells && residual}
		<div class="muted small">
			Demographics predict {fmtMargin(margin(twoPartyD(residual.expected), 0))}; district effect {fmtMargin(residualPoints(residual))}
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
	.share {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.share span:last-child {
		margin-left: auto;
		padding-left: 12px;
		font-variant-numeric: tabular-nums;
	}
</style>
