<script lang="ts">
	import {
		geoAlbersUsa, geoEqualEarth, geoIdentity, geoMercator, geoPath,
		type GeoProjection, type GeoPermissibleObjects
	} from 'd3-geo';
	import type { FeatureCollection, Geometry } from 'geojson';
	import type { LoadedMap, Region } from './types';

	interface Props {
		map: LoadedMap;
		fill: (r: Region) => string;
		/** group (state) to fly to; null = whole map */
		focusGroup: string | null;
		/** primary = left click / tap, secondary = right click */
		onpick: (r: Region, secondary: boolean) => void;
		onhover: (r: Region | null, x: number, y: number) => void;
		onunfocus: () => void;
	}
	let { map, fill, focusGroup, onpick, onhover, onunfocus }: Props = $props();

	const W = 975;
	const H = 610;
	const PAD = 12;
	const MAX_K = 40;

	function makeProjection(kind: string | undefined): GeoProjection {
		switch (kind) {
			case 'albersUsa': return geoAlbersUsa() as unknown as GeoProjection;
			case 'equalEarth': return geoEqualEarth();
			case 'identity': return geoIdentity().reflectY(true) as unknown as GeoProjection;
			default: return geoMercator();
		}
	}

	// Projection is fitted once to the whole map; zooming is a transform on top of it.
	let path = $derived.by(() => {
		const proj = makeProjection(map.manifest.projection);
		proj.fitExtent([[PAD, PAD], [W - PAD, H - PAD]], map.collection as GeoPermissibleObjects);
		return geoPath(proj);
	});
	let shapes = $derived(map.regions.map((r) => ({ r, d: path(r.feature as GeoPermissibleObjects) ?? '' })));
	let borderPath = $derived(map.borders ? path(map.borders as GeoPermissibleObjects) ?? '' : '');

	// ---------- view transform ----------
	// Redrawing ~435 detailed SVG paths per frame is slow, so gestures move `live` and the browser
	// just scales an already-painted GPU layer. Shortly after the gesture stops we commit
	// `live` to `view`, which re-renders the SVG crisply at the new zoom.
	type View = { k: number; x: number; y: number };
	let view = $state<View>({ k: 1, x: 0, y: 0 }); // drawn by the SVG
	let live = $state<View>({ k: 1, x: 0, y: 0 }); // what's on screen
	let animate = $state(false);
	let wrapW = $state(W);
	let wrap: HTMLDivElement;
	let svg: SVGSVGElement;
	let commitTimer: ReturnType<typeof setTimeout> | undefined;

	function setLive(v: View, anim = false) {
		animate = anim;
		live = v;
		clearTimeout(commitTimer);
		commitTimer = setTimeout(commit, anim ? 480 : 150);
	}

	function commit() {
		animate = false;
		view = { ...live };
	}

	let layer = $derived.by(() => {
		const s = live.k / view.k;
		const px = wrapW / W;
		return `translate(${(live.x - s * view.x) * px}px, ${(live.y - s * view.y) * px}px) scale(${s})`;
	});

	function clampView(k: number, x: number, y: number) {
		k = Math.min(MAX_K, Math.max(1, k));
		// keep at least part of the map on screen
		x = Math.min(W * 0.5, Math.max(W * 0.5 - W * k, x));
		y = Math.min(H * 0.5, Math.max(H * 0.5 - H * k, y));
		return { k, x, y };
	}

	function flyTo(group: string | null) {
		if (!group) {
			setLive({ k: 1, x: 0, y: 0 }, true);
			return;
		}
		const fc: FeatureCollection<Geometry> = {
			type: 'FeatureCollection',
			features: map.regions.filter((r) => r.group === group).map((r) => r.feature)
		};
		const [[x0, y0], [x1, y1]] = path.bounds(fc as GeoPermissibleObjects);
		if (!Number.isFinite(x0)) return;
		const k = Math.min(MAX_K, 0.85 / Math.max((x1 - x0) / W, (y1 - y0) / H));
		setLive(clampView(k, W / 2 - (k * (x0 + x1)) / 2, H / 2 - (k * (y0 + y1)) / 2), true);
	}

	$effect(() => {
		flyTo(focusGroup);
	});

	/** client (screen) coords -> SVG viewBox coords */
	function toSvg(cx: number, cy: number) {
		const r = wrap.getBoundingClientRect(); // the wrapper is never transformed
		return { x: ((cx - r.left) / r.width) * W, y: ((cy - r.top) / r.width) * W };
	}

	function zoomAt(px: number, py: number, factor: number, anim = false) {
		const k = Math.min(MAX_K, Math.max(1, live.k * factor));
		const f = k / live.k;
		setLive(clampView(k, px - (px - live.x) * f, py - (py - live.y) * f), anim);
	}

	// Wheel needs a non-passive listener to stop the page from scrolling.
	$effect(() => {
		const onwheel = (e: WheelEvent) => {
			e.preventDefault();
			const p = toSvg(e.clientX, e.clientY);
			zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)));
		};
		svg.addEventListener('wheel', onwheel, { passive: false });
		return () => svg.removeEventListener('wheel', onwheel);
	});

	// ---------- drag to pan, pinch to zoom ----------
	const pointers = new Map<number, { x: number; y: number }>();
	let dragged = false;
	let panning = $state(false);
	let start = { x: 0, y: 0 };
	let pinchDist = 0;

	function onpointerdown(e: PointerEvent) {
		dragged = false;
		if (e.button !== 0) return;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 1) {
			start = { x: e.clientX, y: e.clientY };
		} else if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
		}
	}

	function onpointermove(e: PointerEvent) {
		const prev = pointers.get(e.pointerId);
		if (!prev) return;
		const cur = { x: e.clientX, y: e.clientY };
		pointers.set(e.pointerId, cur);
		if (!dragged && Math.hypot(cur.x - start.x, cur.y - start.y) > 5) {
			dragged = true;
			panning = true;
			onhover(null, 0, 0);
		}
		if (!dragged) return;
		const s = W / wrapW;
		if (pointers.size === 1) {
			setLive(clampView(live.k, live.x + (cur.x - prev.x) * s, live.y + (cur.y - prev.y) * s));
		} else if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			const mid = toSvg((a.x + b.x) / 2, (a.y + b.y) / 2);
			if (pinchDist) zoomAt(mid.x, mid.y, d / pinchDist);
			pinchDist = d;
		}
	}

	function onpointerup(e: PointerEvent) {
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinchDist = 0;
		if (pointers.size === 0) panning = false;
	}

	function pick(r: Region, secondary: boolean) {
		if (dragged) return; // end of a pan, not a click
		onpick(r, secondary);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onunfocus();
	}
</script>

<svelte:window {onkeydown} onpointerup={onpointerup} onpointercancel={onpointerup} />

<div class="wrap" bind:this={wrap} bind:clientWidth={wrapW}>
	<div class="layer" class:animate style:transform={layer}>
	<svg
		bind:this={svg}
		viewBox="0 0 {W} {H}"
		role="application"
		aria-label="{map.manifest.name}. Scroll to zoom, drag to pan."
		class:dragging={panning}
		{onpointerdown}
		{onpointermove}
	>
		<g transform="translate({view.x} {view.y}) scale({view.k})" style:--k={view.k}>
			{#each shapes as { r, d } (r.id)}
				{#if d}
					<path
						{d}
						class="region"
						style:fill={fill(r)}
						role="button"
						tabindex="0"
						aria-label={r.label}
						onclick={() => pick(r, false)}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onpick(r, false); } }}
						oncontextmenu={(e) => { e.preventDefault(); pick(r, true); }}
						onpointermove={(e) => !dragged && onhover(r, e.clientX, e.clientY)}
						onpointerleave={() => onhover(null, 0, 0)}
					/>
				{/if}
			{/each}
			{#if borderPath}<path d={borderPath} class="borders" />{/if}
		</g>
	</svg>
	</div>

	{#if focusGroup}
		<button type="button" class="back" onclick={onunfocus} title="Back to full map (Esc)">
			← {map.manifest.projection === 'albersUsa' ? 'United States' : 'Full map'}
		</button>
	{/if}
	<div class="zoom">
		<button type="button" onclick={() => zoomAt(W / 2, H / 2, 1.6, true)} aria-label="Zoom in">+</button>
		<button type="button" onclick={() => zoomAt(W / 2, H / 2, 1 / 1.6, true)} aria-label="Zoom out">−</button>
		<button type="button" onclick={() => { onunfocus(); flyTo(null); }} aria-label="Reset view" title="Reset view">⟲</button>
	</div>
</div>

<style>
	.wrap {
		position: relative;
		border-radius: 8px;
		overflow: hidden;
		background: var(--surface);
		border: 1px solid var(--border);
	}
	svg {
		width: 100%;
		height: auto;
		display: block;
		user-select: none;
		touch-action: none;
		cursor: grab;
	}
	svg.dragging {
		cursor: grabbing;
	}
	.layer {
		transform-origin: 0 0;
		will-change: transform;
	}
	.layer.animate {
		transition: transform 450ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.region {
		stroke: var(--map-stroke);
		/* divide by zoom so lines stay thin; recomputed only on commit */
		stroke-width: calc(0.5px / var(--k));
		stroke-linejoin: round;
		cursor: pointer;
		transition: fill 120ms;
		outline: none;
	}
	.dragging .region {
		cursor: grabbing;
	}
	.region:hover,
	.region:focus-visible {
		stroke: var(--fg);
		stroke-width: calc(2px / var(--k));
	}
	.borders {
		fill: none;
		stroke: var(--border-strong);
		stroke-width: calc(1.4px / var(--k));
		stroke-linejoin: round;
		pointer-events: none;
	}
	.back {
		position: absolute;
		top: 10px;
		left: 10px;
		font-weight: 600;
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.15);
	}
	.zoom {
		position: absolute;
		top: 10px;
		right: 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.zoom button {
		width: 34px;
		height: 34px;
		padding: 0;
		font-size: 1.1rem;
		line-height: 1;
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.15);
	}
</style>
