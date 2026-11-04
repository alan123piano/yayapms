<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import AboutPanel from '#lib/AboutPanel.svelte';
	import CompareTable from '#lib/CompareTable.svelte';
	import DemographicPanel from '#lib/DemographicPanel.svelte';
	import Header from '#lib/Header.svelte';
	import ImportDialog from '#lib/ImportDialog.svelte';
	import Legend from '#lib/Legend.svelte';
	import MapView from '#lib/MapView.svelte';
	import PartyPanel from '#lib/PartyPanel.svelte';
	import SeatSummary from '#lib/SeatSummary.svelte';
	import ShadingPicker from '#lib/ShadingPicker.svelte';
	import StatePanel from '#lib/StatePanel.svelte';
	import SwingSlider from '#lib/SwingSlider.svelte';
	import Tooltip from '#lib/Tooltip.svelte';
	import {
		DEFAULT_BRUSH, DEFAULT_ELECTION, DEFAULT_SHADING, DEMO_DIM_LABELS, DEMO_LIMITS, SHADINGS, SWING_STOPS,
		type ShadingId
	} from '#lib/config.ts';
	import { applyDemographics, emptySwing, isActive, sanitizeSwing, withAudiences } from '#lib/demographics.ts';
	import { loadPack, withElection } from '#lib/loader.ts';
	import { coreParties, sanitizeParties } from '#lib/parties.ts';
	import { outcomeFill } from '#lib/shading.ts';
	import { buildContext, outcome, tally } from '#lib/sim.ts';
	import type { Level, LoadedMap, Override, Party, Region, StateReport } from '#lib/types.ts';

	// ---------- app state ----------
	let index = $state<{ id: string; name: string }[]>([]);
	/** maps as loaded (raw: large GeoJSON must not be deep-proxied) */
	let loaded = $state.raw<Record<string, LoadedMap>>({});
	let currentId = $state('');
	let election = $state(DEFAULT_ELECTION);
	let swing = $state(0);
	/** per-group vote/turnout changes (Voter groups panel) */
	let demoSwing = $state(emptySwing());
	let parties = $state<Party[]>(coreParties());
	/** manual ratings per map id, then region id */
	let overrides = $state<Record<string, Record<string, Override>>>({});
	let focusGroup = $state<string | null>(null);
	let shading = $state<ShadingId>(DEFAULT_SHADING);
	/** paint brush: a party id or 'auto' */
	let brush = $state(DEFAULT_BRUSH);
	let hover = $state<{ r: Region; x: number; y: number } | null>(null);
	let importing = $state(false);
	let error = $state('');
	let loading = $state(false);

	// ---------- derived ----------
	/** voter groups that some party appeals to */
	let audienceKeys = $derived(parties.flatMap((p) => (p.audience ? [p.audience] : [])));
	/** every map with region results from the selected election, moved by the voter-group swings */
	let maps = $derived(
		Object.fromEntries(
			Object.entries(loaded).map(([id, m]) => {
				const cells = m.elections.find((e) => e.id === election)?.cells;
				const swung = applyDemographics(withElection(m, election), cells, demoSwing);
				return [id, withAudiences(swung, cells, demoSwing, audienceKeys)];
			})
		)
	);
	let map = $derived(maps[currentId]);
	let electionInfo = $derived(map?.elections.find((e) => e.id === election));
	let byId = $derived(Object.fromEntries(parties.map((p) => [p.id, p])) as Record<string, Party>);
	let ov = $derived(overrides[currentId] ?? {});
	let ctx = $derived(map ? buildContext(map.regions, parties, swing, ov) : null);
	let t = $derived(map && ctx ? tally(map.regions, ctx) : null);
	let groups = $derived(map ? [...new Set(map.regions.map((r) => r.group).filter(Boolean))].sort() : []);
	let hasBaseline = $derived(!!map?.regions.some((r) => r.demShare !== null));
	let groupTally = $derived(
		focusGroup && map && ctx ? tally(map.regions.filter((r) => r.group === focusGroup), ctx) : null
	);
	let audienceOptions = $derived(
		electionInfo?.cells
			? electionInfo.cells.order.flatMap((dim) =>
					electionInfo!.cells!.dims[dim].map((group) => ({ dim, group, label: `${DEMO_DIM_LABELS[dim] ?? dim}: ${group}` }))
				)
			: []
	);
	let report = $derived(
		focusGroup && map?.report ? (map.report as Record<string, StateReport>)[focusGroup] : undefined
	);

	// keep the brush valid when parties change
	$effect(() => {
		if (brush !== 'auto' && !parties.some((p) => p.id === brush)) brush = 'auto';
	});

	// ---------- layout: map takes the window height left after the rows around it ----------
	let headerH = $state(56);
	let legendH = $state(40);
	let shadingH = $state(30);
	let hintH = $state(20);
	// + legend/shading/hint margins (10 + 8 + 6) + main padding (24) + map border (2)
	let mapChrome = $derived(legendH + shadingH + hintH + 10 + 8 + 6 + 24 + 2);

	// ---------- loading ----------
	async function ensure(id: string) {
		if (loaded[id]) return;
		loading = true;
		try {
			loaded = { ...loaded, [id]: await loadPack(id) };
		} catch (e) {
			error = `Failed to load ${id}: ${(e as Error).message}`;
		} finally {
			loading = false;
		}
	}

	async function selectMap(id: string) {
		await ensure(id);
		currentId = id;
		const els = loaded[id]?.elections ?? [];
		if (els.length && !els.some((e) => e.id === election)) election = els[els.length - 1].id;
		if (focusGroup && !maps[id]?.regions.some((r) => r.group === focusGroup)) focusGroup = null;
	}

	function onImport(m: LoadedMap) {
		loaded = { ...loaded, [m.manifest.id]: m };
		index = [...index, { id: m.manifest.id, name: `${m.manifest.name} (imported)` }];
		selectMap(m.manifest.id);
		focusGroup = null;
		importing = false;
	}

	// ---------- persistence: URL hash (shareable state) + localStorage (preferences) ----------
	const SWING_MAX = SWING_STOPS[SWING_STOPS.length - 1];
	const STORAGE_KEY = 'yayapms.parties.v2';

	function encodeHash(): string {
		const o = Object.entries(ov).map(([k, v]) => `${k}:${v.p}${v.l}`).join(',');
		const p = new URLSearchParams({ map: currentId, election, swing: String(swing) });
		if (o) p.set('o', o);
		if (focusGroup) p.set('focus', focusGroup);
		if (parties.length > 2) p.set('parties', JSON.stringify(parties.map(({ core, ...rest }) => rest)));
		if (isActive(demoSwing)) p.set('groups', JSON.stringify(demoSwing));
		return p.toString();
	}

	function parseOverride(v: string): Override | null {
		const m = v.match(/^(D|R|p\d{1,3})([1-4])$/);
		return m ? { p: m[1], l: Number(m[2]) as Level } : null;
	}

	/** voter-group swing from the hash; validated once the maps (and their groups) are loaded */
	let pendingGroups: string | null = null;

	/** apply state from the URL hash; returns the map id it names, if any */
	function readHash(): string | null {
		const p = new URLSearchParams(location.hash.slice(1));
		const e = p.get('election');
		if (e && /^[a-z0-9-]{1,40}$/.test(e)) election = e;
		const sw = Number(p.get('swing'));
		if (Number.isFinite(sw) && Math.abs(sw) <= SWING_MAX) swing = sw;
		const id = p.get('map');
		const o: Record<string, Override> = {};
		for (const part of (p.get('o') ?? '').split(',').filter(Boolean)) {
			const i = part.lastIndexOf(':');
			const v = i > 0 ? parseOverride(part.slice(i + 1)) : null;
			if (v) o[part.slice(0, i)] = v;
		}
		if (id) overrides[id] = o;
		focusGroup = p.get('focus');
		pendingGroups = p.get('groups');
		try {
			const ps = sanitizeParties(JSON.parse(p.get('parties') ?? 'null'));
			if (ps) parties = ps;
		} catch { /* ignore malformed */ }
		return id;
	}

	$effect(() => {
		if (!currentId || currentId.startsWith('import-')) return;
		history.replaceState(null, '', '#' + encodeHash());
	});

	$effect(() => {
		const snap = JSON.stringify({ parties, shading });
		try { localStorage.setItem(STORAGE_KEY, snap); } catch { /* storage unavailable */ }
	});

	onMount(async () => {
		try {
			const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
			const ps = sanitizeParties(saved?.parties);
			if (ps) parties = ps;
			if (SHADINGS.some((x) => x.id === saved?.shading)) shading = saved.shading;
		} catch { /* ignore */ }
		const fromHash = readHash(); // hash wins over saved prefs
		try {
			index = await (await fetch('/maps/index.json')).json();
		} catch {
			error = 'Could not load /maps/index.json — run `make data` first.';
			return;
		}
		const first = index.find((m) => m.id === fromHash)?.id ?? index[0]?.id;
		await Promise.all(index.map((m) => ensure(m.id)));
		if (first) await selectMap(first);
		const dims = loaded[currentId]?.elections.find((e) => e.cells)?.cells?.dims;
		if (pendingGroups && dims) {
			try { demoSwing = sanitizeSwing(JSON.parse(pendingGroups), dims, DEMO_LIMITS); } catch { /* ignore */ }
		}
	});

	// ---------- painting ----------
	function setOverride(id: string, v: Override | null) {
		const next = { ...ov };
		if (v === null) delete next[id];
		else next[id] = v;
		overrides[currentId] = next;
	}

	/** Left click paints with the brush; clicking the same party again steps Safe→Likely→Lean→Tilt→Safe.
	 *  Right click returns the region to auto (baseline + swing). */
	function pick(r: Region, secondary: boolean) {
		if (!ctx) return;
		if (secondary || brush === 'auto') return setOverride(r.id, null);
		const cur = outcome(r, ctx);
		const level = cur.winner === brush ? cur.level : 0;
		setOverride(r.id, { p: brush, l: (level <= 1 ? 4 : level - 1) as Level });
	}

	function fill(r: Region): string {
		return ctx ? outcomeFill(outcome(r, ctx), byId, shading) : 'var(--unrated)';
	}
</script>

<svelte:head><title>yayapms</title></svelte:head>

<Header
	maps={index}
	{currentId}
	elections={map?.elections ?? []}
	bind:election
	{groups}
	bind:focusGroup
	{loading}
	onselectmap={selectMap}
	onimport={() => (importing = true)}
	bind:height={headerH}
/>

{#if error}<p class="error banner">{error}</p>{/if}

<main style:--header-h="{headerH}px" style:--map-chrome="{mapChrome}px">
	<section class="map">
		{#if map}
			<Legend {parties} tally={t} {hasBaseline} bind:brush bind:height={legendH} />
			<MapView
				{map}
				{fill}
				{focusGroup}
				onpick={pick}
				onhover={(r, x, y) => (hover = r ? { r, x, y } : null)}
				onunfocus={() => (focusGroup = null)}
			/>
			<ShadingPicker bind:shading bind:height={shadingH} />
			<p class="hint muted small" bind:offsetHeight={hintH}>
				Click to paint, again to cycle Safe → Tilt · right-click resets · scroll/drag to zoom/pan · Esc zooms out
			</p>
		{/if}
	</section>

	<aside>
		{#if t && map}
			<SeatSummary tally={t} {parties} />
			{#if hasBaseline}
				<SwingSlider bind:swing baseline={electionInfo?.label ?? 'baseline'} />
			{/if}
			{#if electionInfo?.cells && hasBaseline}
				<h3>Voter groups</h3>
				<DemographicPanel regions={map.regions} cells={electionInfo.cells} bind:swing={demoSwing} />
			{/if}
			{#if Object.keys(ov).length}
				<button type="button" class="link" onclick={() => (overrides[currentId] = {})}>clear {Object.keys(ov).length} manual ratings</button>
			{/if}

			<h3>Parties</h3>
			<PartyPanel bind:parties {groups} audiences={audienceOptions} />

			<CompareTable {maps} {currentId} {parties} {swing} {overrides} />

			{#if focusGroup && groupTally}
				<StatePanel group={focusGroup} tally={groupTally} {parties} {report} onback={() => (focusGroup = null)} />
			{/if}

			<AboutPanel mapDescription={map.manifest.description} election={electionInfo} />
		{/if}
	</aside>
</main>

{#if hover && ctx}
	<Tooltip
		region={hover.r}
		outcome={outcome(hover.r, ctx)}
		x={hover.x}
		y={hover.y}
		{byId}
		{swing}
		electionLabel={electionInfo?.label ?? 'Baseline'}
	/>
{/if}

{#if importing}
	<ImportDialog onload={onImport} onclose={() => (importing = false)} />
{/if}

<style>
	main {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 16px;
		padding: 12px 16px;
		max-width: 1500px;
		margin: 0 auto;
	}
	/* Side-by-side layout: the map is scaled to fit the window height minus the measured rows
	   around it (--map-chrome) and stays in view (sticky) while the page scrolls the sidebar. */
	@media (min-width: 861px) {
		main {
			align-items: start;
		}
		.map {
			--map-max-w: calc((100dvh - var(--header-h) - var(--map-chrome)) * 975 / 610);
			position: sticky;
			top: 12px;
		}
	}
	@media (max-width: 860px) {
		main {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.hint {
		margin: 6px 0 0;
	}
	.banner {
		margin: 8px 16px;
	}
</style>
