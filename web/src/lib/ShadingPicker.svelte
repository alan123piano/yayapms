<script lang="ts">
	import { SHADINGS, type ShadingId } from './config';

	interface Props {
		shading: ShadingId;
		height?: number;
	}
	let { shading = $bindable(), height = $bindable() }: Props = $props();
</script>

<div class="shading" role="radiogroup" aria-label="Shading" bind:offsetHeight={height}>
	<span class="muted small">Shading</span>
	{#each SHADINGS as x (x.id)}
		<button type="button" role="radio" aria-checked={shading === x.id} class:active={shading === x.id} title={x.hint} onclick={() => (shading = x.id)}>{x.label}</button>
	{/each}
</div>

<style>
	.shading {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 8px;
	}
	span {
		margin-right: 4px;
	}
	button {
		padding: 3px 10px;
		font-size: 0.85rem;
	}
	button.active {
		background: var(--fg);
		color: var(--bg);
		border-color: var(--fg);
	}
</style>
