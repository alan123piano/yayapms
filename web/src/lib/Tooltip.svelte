<script lang="ts">
	import { fmtMargin } from './format';
	import { ratingText } from './shading';
	import { margin } from './sim';
	import type { Outcome, Party, Region } from './types';

	interface Props {
		region: Region;
		outcome: Outcome;
		/** pointer position (viewport px) */
		x: number;
		y: number;
		byId: Record<string, Party>;
		swing: number;
		/** short election name shown before the margin, e.g. "2024 President" */
		electionLabel: string;
	}
	let { region: r, outcome: o, x, y, byId, swing, electionLabel }: Props = $props();

	let twoParty = $derived(Object.keys(byId).length === 2);
</script>

<div class="tip" style:left="{x + 14}px" style:top="{y + 14}px">
	<b>{r.label}</b>
	{#if o.shares}
		{#if twoParty && r.demShare !== null}
			<div>{electionLabel}: {fmtMargin(margin(r.demShare, 0))}{swing ? ` → ${fmtMargin(margin(r.demShare, swing))}` : ''}</div>
		{:else}
			{#each Object.entries(o.shares).sort((a, b) => b[1] - a[1]) as [id, v] (id)}
				<div class="share"><span class="swatch sm" style:background={byId[id]?.color}></span>{byId[id]?.name ?? id}<span>{(v * 100).toFixed(1)}%</span></div>
			{/each}
		{/if}
	{/if}
	<div>{ratingText(o, byId)}{o.manual ? ' (manual)' : ''}</div>
	{#if r.seats !== 1}<div>{r.seats} seats</div>{/if}
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
