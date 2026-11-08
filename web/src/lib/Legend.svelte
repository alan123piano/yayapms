<script lang="ts">
	import { spectrumOrder } from './parties';
	import type { Tally } from './sim';
	import type { Party } from './types';

	interface Props {
		parties: Party[];
		tally: Tally | null;
		height?: number;
	}
	let { parties, tally, height = $bindable() }: Props = $props();

	/** parties on the ballot: any seat, or the election's own */
	let shown = $derived(spectrumOrder(parties).filter((p) => p.core || (tally?.seats[p.id] ?? 0) > 0));
</script>

<ul class="legend" aria-label="Seats by party" bind:offsetHeight={height}>
	{#each shown as p (p.id)}
		<li><span class="swatch" style:background={p.color}></span>{p.name}{#if tally}<b>{tally.seats[p.id] ?? 0}</b>{/if}</li>
	{/each}
</ul>

<style>
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 16px;
		list-style: none;
		padding: 0;
		margin: 0 0 10px;
	}
	li {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
	}
	b {
		font-variant-numeric: tabular-nums;
	}
</style>
