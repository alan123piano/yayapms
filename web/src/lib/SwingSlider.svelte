<script lang="ts">
	import { SWING_LABELS, SWING_STOPS } from './config';
	import { fmtMargin, swingLabel } from './format';

	interface Props {
		/** uniform two-party swing in points (+ = toward D) */
		swing: number;
		/** what the swing is relative to, e.g. "2024 President" */
		baseline: string;
	}
	let { swing = $bindable(), baseline }: Props = $props();

	// discrete stops, evenly spaced on the bar
	const VALUES = [...SWING_STOPS.map((v) => -v).reverse(), 0, ...SWING_STOPS];
	const LABELED = new Set(SWING_LABELS);
	const nearestIndex = (s: number) =>
		VALUES.reduce((best, v, i) => (Math.abs(v - s) < Math.abs(VALUES[best] - s) ? i : best), 0);
	const pct = (i: number) => (i / (VALUES.length - 1)) * 100;
</script>

<label>
	<span>D/R swing vs. {baseline}: <b>{fmtMargin(swing)}</b></span>
	<input
		type="range"
		min="0"
		max={VALUES.length - 1}
		step="1"
		value={nearestIndex(swing)}
		oninput={(e) => (swing = VALUES[Number(e.currentTarget.value)])}
	/>
</label>
<div class="ticks">
	{#each VALUES as v, i (v)}
		<span class="dot" class:major={LABELED.has(v)} style:left="{pct(i)}%"></span>
		{#if LABELED.has(v)}
			<button type="button" style:left="{pct(i)}%" class:on={swing === v} onclick={() => (swing = v)}>{swingLabel(v)}</button>
		{/if}
	{/each}
</div>

<style>
	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 16px;
		font-size: 0.9rem;
	}
	/* Custom slider so the thumb geometry is exact: its center travels from THUMB/2 to
	   width - THUMB/2, and the tick row is inset by the same amount. */
	input {
		--thumb: 14px;
		-webkit-appearance: none;
		appearance: none;
		width: 100%;
		height: var(--thumb);
		margin: 0;
		background: none;
		cursor: pointer;
	}
	input::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
		background: var(--border);
	}
	input::-moz-range-track {
		height: 4px;
		border-radius: 2px;
		background: var(--border);
	}
	input::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: var(--thumb);
		height: var(--thumb);
		margin-top: calc(2px - var(--thumb) / 2);
		border-radius: 50%;
		background: var(--fg);
		border: 2px solid var(--surface);
		box-sizing: border-box;
	}
	input::-moz-range-thumb {
		width: var(--thumb);
		height: var(--thumb);
		border-radius: 50%;
		background: var(--fg);
		border: 2px solid var(--surface);
		box-sizing: border-box;
	}
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.ticks {
		position: relative;
		height: 30px;
		margin: 4px 7px 4px; /* 7px = half of --thumb */
	}
	.dot {
		position: absolute;
		top: 0;
		width: 3px;
		height: 3px;
		border-radius: 50%;
		background: var(--muted);
		transform: translateX(-50%);
		opacity: 0.6;
	}
	.dot.major {
		opacity: 1;
		width: 1px;
		height: 6px;
		border-radius: 0;
	}
	.ticks button {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
		border: none;
		background: none;
		padding: 8px 0 0;
		font-size: 0.8rem;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.ticks button.on {
		color: var(--fg);
		font-weight: 600;
	}
</style>
