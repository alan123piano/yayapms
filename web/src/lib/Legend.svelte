<script lang="ts">
	import { spectrumOrder } from './parties';
	import type { Tally } from './sim';
	import type { Party } from './types';

	interface Props {
		parties: Party[];
		tally: Tally | null;
		/** whether the map has election results (else 'auto' just clears) */
		hasBaseline: boolean;
		/** selected paint brush: a party id or 'auto' */
		brush: string;
		height?: number;
	}
	let { parties, tally, hasBaseline, brush = $bindable(), height = $bindable() }: Props = $props();

	let brushes = $derived([
		...spectrumOrder(parties).map((p) => ({ id: p.id, label: p.name, color: p.color, n: tally?.seats[p.id] })),
		{ id: 'auto', label: hasBaseline ? 'Auto (baseline)' : 'Clear', color: 'transparent', n: undefined }
	]);
</script>

<div class="legend" role="radiogroup" aria-label="Paint with" bind:offsetHeight={height}>
	{#each brushes as b (b.id)}
		<button type="button" role="radio" aria-checked={brush === b.id} class:active={brush === b.id} onclick={() => (brush = b.id)}>
			<span class="swatch" class:auto={b.id === 'auto'} style:background={b.color}></span>
			{b.label}
			{#if b.n !== undefined}<b>{b.n}</b>{/if}
		</button>
	{/each}
</div>

<style>
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 10px;
	}
	button {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		border-radius: 999px;
	}
	button.active {
		border-color: var(--fg);
		box-shadow: inset 0 0 0 1px var(--fg);
	}
	b {
		font-variant-numeric: tabular-nums;
	}
	.swatch.auto {
		border: 2px dashed var(--muted);
	}
</style>
