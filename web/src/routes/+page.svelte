<script lang="ts">
	import '../app.css';
	import { onMount, untrack } from 'svelte';
	import AboutPanel from '#lib/AboutPanel.svelte';
	import CompareTable from '#lib/CompareTable.svelte';
	import DemographicPanel from '#lib/DemographicPanel.svelte';
	import Header from '#lib/Header.svelte';
	import ImportDialog from '#lib/ImportDialog.svelte';
	import Legend from '#lib/Legend.svelte';
	import MapView from '#lib/MapView.svelte';
	import ModelFit from '#lib/ModelFit.svelte';
	import PartyPanel from '#lib/PartyPanel.svelte';
	import SeatSummary from '#lib/SeatSummary.svelte';
	import SeatSystemPicker from '#lib/SeatSystemPicker.svelte';
	import ShadingPicker from '#lib/ShadingPicker.svelte';
	import StatePanel from '#lib/StatePanel.svelte';
	import Tooltip from '#lib/Tooltip.svelte';
	import VoteMatrix from '#lib/VoteMatrix.svelte';
	import {
		DEFAULT_BRUSH, DEFAULT_ELECTION, DEFAULT_SHADING, DEMO_DIM_LABELS, DEMO_LIMITS, SHADINGS,
		type ShadingId
	} from '#lib/config.ts';
	import { describe, emptySwing, filterKey, isActive, sanitizeSwing, type GroupOption } from '#lib/demographics.ts';
	import { electionParties, loadPack, withElection } from '#lib/loader.ts';
	import { BASELINE_VARIANTS, baselineFor, fitAppeal, fitBasis, unexplained, type Basis, type BaselineVariant, type Scenario } from '#lib/model.ts';
	import { coreParties, sanitizeParties, withElectionParties } from '#lib/parties.ts';
	import { outcomeFill, residualFill } from '#lib/shading.ts';
	import { buildContext, FPTP, outcome, tally, type SeatSystem } from '#lib/sim.ts';
	import type { Level, LoadedMap, Override, Party, Region, StateReport } from '#lib/types.ts';

	// ---------- app state ----------
	let index = $state<{ id: string; name: string }[]>([]);
	/** maps as loaded (raw: large GeoJSON must not be deep-proxied) */
	let loaded = $state.raw<Record<string, LoadedMap>>({});
	let currentId = $state('');
	let election = $state(DEFAULT_ELECTION);
	/** which version of the election to start from: real, model only, demographics only */
	let variant = $state<BaselineVariant>('real');
	/** per-group vote/turnout changes (Voter groups panel) */
	let demoSwing = $state(emptySwing());
	let parties = $state<Party[]>(coreParties());
	/** how seats are assigned: FPTP, or mixed-member proportional */
	let seatSystem = $state<SeatSystem>(FPTP);
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
	/** every map with region results from the selected election */
	let electionMaps = $derived(Object.fromEntries(Object.entries(loaded).map(([id, m]) => [id, withElection(m, election)])));
	/** fitted vote models (model.fitBasis) by "map|election". Fitting takes most of a second per
	 *  map, so it runs in a worker (fit.worker.ts); the main thread fits only if workers fail. */
	let fitCache = $state.raw<Record<string, Basis>>({});
	let fitsPending = $state(0);
	let fitter: Worker | null | undefined;
	const pendingKeys = new Set<string>();
	function requestFit(id: string, m: LoadedMap, eid: string) {
		const key = `${id}|${eid}`;
		if (fitCache[key] || pendingKeys.has(key)) return;
		const cells = m.elections.find((e) => e.id === eid)?.cells;
		const done = (basis: Basis) => {
			pendingKeys.delete(key);
			fitsPending = pendingKeys.size;
			fitCache = { ...fitCache, [key]: basis };
		};
		if (fitter === undefined) {
			try {
				fitter = new Worker(new URL('../lib/fit.worker.ts', import.meta.url), { type: 'module' });
				fitter.onmessage = (e) => {
					const { key: k, basis, error: err } = e.data;
					pendingKeys.delete(k);
					fitsPending = pendingKeys.size;
					if (err) error = `Could not fit the vote model for ${k.split('|')[0]}: ${err}`;
					else fitCache = { ...fitCache, [k]: basis };
				};
			} catch {
				fitter = null;
			}
		}
		pendingKeys.add(key);
		fitsPending = pendingKeys.size;
		if (fitter) {
			fitter.postMessage({ key, regions: m.regions.map(({ feature, ...r }) => r), cells, local: m.local });
		} else {
			done(fitBasis(m.regions, cells, m.local));
		}
	}
	$effect(() => {
		const eid = election;
		for (const [id, m] of Object.entries(electionMaps)) untrack(() => requestFit(id, m, eid));
	});
	/** the fitted vote model per map: national cell matrix + state patterns + district residuals */
	let fitted = $derived(
		Object.fromEntries(
			Object.keys(electionMaps).flatMap((id) => {
				const b = fitCache[`${id}|${election}`];
				return b ? [[id, b]] : [];
			})
		) as Record<string, Basis>
	);
	const hasCellsFor = (id: string) => !!loaded[id]?.elections.find((e) => e.id === election)?.cells;
	/** the baseline the simulation starts from: the real election, or demographics only */
	let bases = $derived(
		Object.fromEntries(
			Object.entries(fitted).map(([id, b]) => [id, hasCellsFor(id) ? baselineFor(b, variant) : b])
		) as Record<string, Basis>
	);
	let maps = $derived(electionMaps);
	let scenario = $derived<Scenario>({ segments: demoSwing.segments, parties });
	/** the scenario for the Compare maps table: it re-runs every map, so it follows the
	 *  scenario only once a slider has been still for a moment (not on every drag step) */
	let settled = $state.raw<Scenario | null>(null);
	$effect(() => {
		const snap = $state.snapshot(scenario) as Scenario;
		const t = setTimeout(() => (settled = snap), untrack(() => settled) ? 250 : 0);
		return () => clearTimeout(t);
	});
	let map = $derived(maps[currentId]);
	let electionInfo = $derived(map?.elections.find((e) => e.id === election));
	let baselineLabel = $derived(
		electionInfo
			? `${electionInfo.label}${variant !== 'real' && electionInfo.cells ? ` (${BASELINE_VARIANTS.find((x) => x.id === variant)?.label})` : ''}`
			: 'Baseline'
	);
	let byId = $derived(Object.fromEntries(parties.map((p) => [p.id, p])) as Record<string, Party>);
	let ov = $derived(overrides[currentId] ?? {});
	let ctx = $derived(map ? buildContext(bases[currentId], map.regions, scenario, ov) : null);
	let t = $derived(map && ctx ? tally(map.regions, ctx, seatSystem) : null);
	let groups = $derived(map ? [...new Set(map.regions.map((r) => r.group).filter(Boolean))].sort() : []);
	let hasBaseline = $derived(!!map?.regions.some((r) => r.baseline));

	// the parties list always holds the election's own parties (from its data), in data order
	$effect(() => {
		const el = electionInfo;
		if (!el) return;
		const ids = electionParties(el);
		untrack(() => {
			const next = withElectionParties(parties, ids, el.candidates ?? {});
			if (next.map((p) => `${p.id}:${p.core}`).join() !== parties.map((p) => `${p.id}:${p.core}`).join()) parties = next;
		});
	});
	let groupTally = $derived(
		focusGroup && map && ctx ? tally(map.regions.filter((r) => r.group === focusGroup), ctx) : null
	);
	/** voter groups a party can appeal to: every single group, plus custom groups */
	let audienceOptions = $derived.by((): GroupOption[] => {
		const c = electionInfo?.cells;
		if (!c) return [];
		const single = c.order.flatMap((dim) =>
			c.dims[dim].map((group) => {
				const filter = { [dim]: [group] };
				return { key: filterKey(filter), label: group, dim: DEMO_DIM_LABELS[dim] ?? dim, filter, custom: false };
			})
		);
		const custom = demoSwing.segments
			.filter((g) => g.custom && Object.keys(g.filter).length)
			.map((g) => ({ key: filterKey(g.filter), label: describe(g.filter, c.order), filter: g.filter, custom: true }));
		return [...single, ...custom.filter((x, k) => custom.findIndex((y) => y.key === x.key) === k)];
	});
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
	const STORAGE_KEY = 'yayapms.parties.v2';

	function encodeHash(): string {
		const o = Object.entries(ov).map(([k, v]) => `${k}:${v.p}${v.l}`).join(',');
		const p = new URLSearchParams({ map: currentId, election });
		if (variant !== 'real') p.set('baseline', variant);
		if (o) p.set('o', o);
		if (focusGroup) p.set('focus', focusGroup);
		if (seatSystem.kind === 'mmp') {
			const m = seatSystem;
			p.set('seats', `mmp:${m.listSeats}:${m.threshold}:${m.waiver}:${m.overhang}`);
		}
		if (parties.length > 2 || parties.some((x) => x.appeals.length)) p.set('parties', JSON.stringify(parties.map(({ core, ...rest }) => rest)));
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
		const oldSwing = Number.isFinite(sw) && Math.abs(sw) <= 40 ? sw : 0;
		const bv = p.get('baseline');
		variant = BASELINE_VARIANTS.some((x) => x.id === bv) ? (bv as BaselineVariant) : 'real';
		const id = p.get('map');
		const o: Record<string, Override> = {};
		for (const part of (p.get('o') ?? '').split(',').filter(Boolean)) {
			const i = part.lastIndexOf(':');
			const v = i > 0 ? parseOverride(part.slice(i + 1)) : null;
			if (v) o[part.slice(0, i)] = v;
		}
		if (id) overrides[id] = o;
		focusGroup = p.get('focus');
		const seats = (p.get('seats') ?? '').match(/^mmp:(\d{1,3}):(\d{1,2}(?:\.\d)?):(\d{1,2}):(keep|level)$/);
		if (seats) {
			seatSystem = {
				kind: 'mmp', listSeats: Math.min(300, Number(seats[1])), threshold: Math.min(20, Number(seats[2])),
				waiver: Number(seats[3]), overhang: seats[4] as 'keep' | 'level'
			};
		}
		pendingGroups = p.get('groups');
		try {
			const ps = sanitizeParties(JSON.parse(p.get('parties') ?? 'null'));
			if (ps) parties = ps;
		} catch { /* ignore malformed */ }
		// older links: a uniform D-vs-R swing of m margin points ≈ a D appeal of m/2 among everyone
		const d = parties.find((x) => x.id === 'D');
		if (oldSwing && d) d.appeals = [...d.appeals.filter((a) => Object.keys(a.filter).length), { filter: {}, points: oldSwing / 2 }];
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
			try {
				const { swing: sw, votes } = sanitizeSwing(JSON.parse(pendingGroups), dims, DEMO_LIMITS);
				demoSwing = sw;
				// older links: a D-vs-R vote swing of m margin points ≈ a D appeal of m/2 points
				const d = parties.find((x) => x.id === 'D');
				for (const v of votes) if (d) d.appeals = [...d.appeals, { filter: v.filter, points: v.vote / 2 }];
			} catch { /* ignore */ }
		}
	});

	// older links stored share targets: fit them once the current map's model is ready
	$effect(() => {
		if (bases[currentId] && map && parties.some((p) => p.appeals.some((a) => a.target !== undefined))) untrack(fitLegacyTargets);
	});

	/** older links stored share targets: fit each one to an appeal, once */
	function fitLegacyTargets() {
		const b = bases[currentId];
		if (!b || !map) return;
		for (const p of parties) {
			for (const a of p.appeals) {
				if (a.target === undefined) continue;
				const f = $state.snapshot(a.filter);
				a.points = fitAppeal(b, map.regions, $state.snapshot(scenario), p.id, f, a.target / 100).points;
				delete a.target;
			}
		}
	}

	/** "fit to…" from the Voter groups panel */
	function fit(partyId: string, filter: Record<string, string[]>, target: number): boolean {
		const b = bases[currentId];
		const p = parties.find((x) => x.id === partyId);
		if (!b || !map || !p) return false;
		const r = fitAppeal(b, map.regions, $state.snapshot(scenario), partyId, filter, target);
		if (!r.reached) return false;
		const key = filterKey(filter);
		p.appeals = [...p.appeals.filter((a) => filterKey(a.filter) !== key), ...(r.points ? [{ filter: structuredClone(filter), points: r.points }] : [])];
		return true;
	}

	// ---------- painting ----------
	function setOverride(id: string, v: Override | null) {
		const next = { ...ov };
		if (v === null) delete next[id];
		else next[id] = v;
		overrides[currentId] = next;
	}

	/** Left click paints with the brush; clicking the same party again steps Safe→Likely→Lean→Tilt→Safe.
	 *  Right click returns the region to auto (the simulated result). */
	function pick(r: Region, secondary: boolean) {
		if (!ctx) return;
		if (secondary || brush === 'auto') return setOverride(r.id, null);
		const cur = outcome(r, ctx);
		const level = cur.winner === brush ? cur.level : 0;
		setOverride(r.id, { p: brush, l: (level <= 1 ? 4 : level - 1) as Level });
	}

	function fill(r: Region): string {
		if (shading === 'residual') {
			const rb = fitted[currentId]?.regions.get(r.id);
			return rb ? residualFill(unexplained(rb), byId) : 'var(--unrated)';
		}
		return ctx ? outcomeFill(outcome(r, ctx), byId, shading) : 'var(--unrated)';
	}
</script>

<svelte:head><title>yayapms</title></svelte:head>

<Header
	maps={index}
	{currentId}
	elections={map?.elections ?? []}
	bind:election
	bind:variant
	{groups}
	bind:focusGroup
	loading={loading || fitsPending > 0}
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
			<SeatSystemPicker bind:system={seatSystem} />
			{#if electionInfo?.cells && hasBaseline}
				<h3>Voter groups</h3>
				{#if ctx?.sim}<DemographicPanel sim={ctx.sim} cells={electionInfo.cells} bind:swing={demoSwing} bind:parties onfit={fit} />{/if}
			{/if}
			{#if Object.keys(ov).length}
				<button type="button" class="link" onclick={() => (overrides[currentId] = {})}>clear {Object.keys(ov).length} manual ratings</button>
			{/if}

			<h3>Parties</h3>
			<PartyPanel bind:parties {groups} sim={ctx?.sim ?? null} />

			{#if electionInfo?.cells && ctx?.sim}
				<h3>Vote by group</h3>
				<VoteMatrix sim={ctx.sim} {parties} cells={electionInfo.cells} custom={audienceOptions.filter((a) => a.custom)} {baselineLabel} />
			{/if}

			{#if electionInfo?.cells && fitted[currentId]}
				<h3>What explains each district</h3>
				<ModelFit fit={fitted[currentId].fit} {parties} />
			{/if}

			{#if settled}<CompareTable {maps} {bases} {currentId} scenario={settled} {overrides} {seatSystem} />{/if}

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
		residual={fitted[currentId]?.regions.get(hover.r.id)}
		before={bases[currentId]?.regions.get(hover.r.id)}
		hasCells={!!electionInfo?.cells}
		electionLabel={baselineLabel}
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
			top: calc(var(--header-h) + 12px);
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
