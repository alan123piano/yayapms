<script lang="ts">
	import { SWING_LABELS, SWING_STOPS } from './config';
	import { fmtMargin, swingLabel } from './format';
	import Scrubber from './Scrubber.svelte';

	interface Props {
		/** uniform two-party swing in points (+ = toward D) */
		swing: number;
		/** what the swing is relative to, e.g. "2024 President" */
		baseline: string;
	}
	let { swing = $bindable(), baseline }: Props = $props();

	const STOPS = [...SWING_STOPS.map((v) => -v).reverse(), 0, ...SWING_STOPS];
</script>

<label>
	<span>D/R swing vs. {baseline}: <b>{fmtMargin(swing)}</b></span>
	<Scrubber bind:value={swing} stops={STOPS} labels={SWING_LABELS} format={swingLabel} origin={0} />
</label>

<style>
	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 16px;
		font-size: 0.9rem;
	}
</style>
