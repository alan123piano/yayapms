<script module lang="ts">
	/** evenly stepped stops from min to max inclusive */
	export function stepped(min: number, max: number, step: number): number[] {
		const out: number[] = [];
		for (let v = min; v <= max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
		return out;
	}
</script>

<script lang="ts">
	/*
	 * A slider over discrete stops, drawn evenly spaced on the bar (so stops need not be linear).
	 * The track fills from `origin` to the value, hovering previews the stop a click would land on,
	 * and labeled stops under the bar are clickable shortcuts.
	 */
	interface Props {
		value: number;
		/** allowed values, ascending */
		stops: number[];
		/** stops that get a tick mark (default: every stop) */
		ticks?: number[];
		/** stops that get a clickable label under the bar */
		labels?: number[];
		/** formats tick labels, the hover preview and the screen-reader value */
		format?: (v: number) => string;
		/** the fill runs from here to the value (default: the first stop) */
		origin?: number;
		onchange?: (v: number) => void;
		'aria-label'?: string;
	}
	let {
		value = $bindable(), stops, ticks = stops, labels = [], format = String,
		origin = stops[0], onchange, 'aria-label': ariaLabel
	}: Props = $props();

	const nearest = (v: number) =>
		stops.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(stops[best] - v) ? i : best), 0);
	const pos = (i: number) => (stops.length > 1 ? (i / (stops.length - 1)) * 100 : 0);

	let index = $derived(nearest(value));
	let lo = $derived(Math.min(pos(nearest(origin)), pos(index)));
	let hi = $derived(Math.max(pos(nearest(origin)), pos(index)));
	let labelSet = $derived(new Set(labels));

	function set(v: number) {
		if (v === value) return;
		value = v;
		onchange?.(v);
	}

	// hover preview: which stop the pointer is over (thumb centers travel THUMB/2 .. width - THUMB/2)
	const THUMB = 14;
	let hover = $state<number | null>(null);
	let dragging = $state(false);
	function track(e: PointerEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const f = (e.clientX - r.left - THUMB / 2) / (r.width - THUMB);
		hover = Math.round(Math.min(1, Math.max(0, f)) * (stops.length - 1));
	}
	let showHover = $derived(hover !== null && hover !== index && !dragging);

	/** edge labels hug the bar's ends instead of overhanging them */
	const anchor = (i: number) => (i === 0 ? 'start' : i === stops.length - 1 ? 'end' : 'mid');
</script>

<svelte:window onpointerup={() => (dragging = false)} onpointercancel={() => (dragging = false)} />

<div class="scrubber" style:--lo={lo / 100} style:--hi={hi / 100}>
	<input
		type="range"
		min="0"
		max={stops.length - 1}
		step="1"
		value={index}
		aria-label={ariaLabel}
		aria-valuetext={format(value)}
		oninput={(e) => set(stops[Number(e.currentTarget.value)])}
		onpointermove={track}
		onpointerleave={() => (hover = null)}
		onpointerdown={() => (dragging = true)}
	/>
	{#if showHover && hover !== null}
		<span class="ghost" style:--p={pos(hover) / 100}></span>
		<span class="peek {anchor(hover)}" style:--p={pos(hover) / 100}>{format(stops[hover])}</span>
	{/if}
	<div class="ticks" class:labeled={labels.length > 0}>
		{#each stops as s, i (s)}
			{#if labelSet.has(s)}
				<span class="tick major" style:left="{pos(i)}%"></span>
				<button
					type="button"
					class="{anchor(i)}"
					class:on={i === index}
					style:left="{pos(i)}%"
					onclick={() => set(s)}>{format(s)}</button
				>
			{:else if ticks.includes(s)}
				<span class="tick" class:hot={showHover && i === hover} style:left="{pos(i)}%"></span>
			{/if}
		{/each}
	</div>
</div>

<style>
	.scrubber {
		--thumb: 14px;
		position: relative;
		min-width: 0;
	}
	input {
		-webkit-appearance: none;
		appearance: none;
		display: block;
		width: 100%;
		height: 20px; /* a taller hit area than the 4px track */
		margin: 0;
		background: none;
		cursor: pointer;
		/* fill from origin to value, in thumb-center coordinates (--lo/--hi are 0..1) */
		--a: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--lo));
		--b: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--hi));
		--fill: linear-gradient(
			to right,
			var(--border) var(--a),
			var(--accent) var(--a),
			var(--accent) var(--b),
			var(--border) var(--b)
		);
	}
	input::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
		background: var(--fill);
	}
	input::-moz-range-track {
		height: 4px;
		border-radius: 2px;
		background: var(--fill);
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
		transition: transform 0.12s, box-shadow 0.12s;
	}
	input::-moz-range-thumb {
		width: var(--thumb);
		height: var(--thumb);
		border-radius: 50%;
		background: var(--fg);
		border: 2px solid var(--surface);
		box-sizing: border-box;
		transition: transform 0.12s, box-shadow 0.12s;
	}
	input:hover::-webkit-slider-thumb {
		transform: scale(1.2);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent);
	}
	input:hover::-moz-range-thumb {
		transform: scale(1.2);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent);
	}
	input:active::-webkit-slider-thumb {
		transform: scale(1.3);
		box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 30%, transparent);
	}
	input:active::-moz-range-thumb {
		transform: scale(1.3);
		box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 30%, transparent);
	}
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 4px;
	}

	/* hover overlays sit at a thumb center: THUMB/2 + (width - THUMB) * p */
	.ghost,
	.peek {
		position: absolute;
		left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--p));
		pointer-events: none;
	}
	.ghost {
		top: 10px;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 2px solid var(--accent);
		background: var(--surface);
		transform: translate(-50%, -50%);
	}
	.peek {
		bottom: 100%;
		margin-bottom: 2px;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--fg);
		color: var(--bg);
		font-size: 0.75rem;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		z-index: 1;
	}

	.ticks {
		position: relative;
		height: 6px;
		margin: 2px calc(var(--thumb) / 2) 0;
	}
	.ticks.labeled {
		height: 22px;
	}
	.tick {
		position: absolute;
		top: 0;
		width: 3px;
		height: 3px;
		border-radius: 50%;
		background: var(--muted);
		transform: translateX(-50%);
		opacity: 0.5;
		transition: transform 0.1s, opacity 0.1s;
	}
	.tick.hot {
		opacity: 1;
		background: var(--accent);
		transform: translateX(-50%) scale(1.6);
	}
	.tick.major {
		opacity: 0.9;
		width: 1px;
		height: 6px;
		border-radius: 0;
	}
	.ticks button {
		position: absolute;
		top: 0;
		border: none;
		background: none;
		padding: 6px 2px 0;
		font-size: 0.75rem;
		line-height: 1.2;
		color: var(--muted);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.ticks button:hover {
		color: var(--accent);
	}
	.ticks button.on {
		color: var(--fg);
		font-weight: 600;
	}
	.mid {
		transform: translateX(-50%);
	}
	.start {
		transform: translateX(calc(var(--thumb) / -2));
	}
	.end {
		transform: translateX(calc(-100% + var(--thumb) / 2));
	}
</style>
