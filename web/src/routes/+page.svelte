<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import MapView from '#lib/MapView.svelte';
	import ImportDialog from '#lib/ImportDialog.svelte';
	import PartyPanel from '#lib/PartyPanel.svelte';
	import { loadPack, withElection } from '#lib/loader.ts';
	import { coreParties, sanitizeParties, spectrumOrder } from '#lib/parties.ts';
	import { buildContext, margin, outcome, tally, tippingSwing, type SimContext, type Tally } from '#lib/sim.ts';
	import { RATING_NAMES, type Level, type LoadedMap, type Outcome, type Override, type Party, type Region } from '#lib/types.ts';

	// ---------- state ----------
	let index = $state<{ id: string; name: string }[]>([]);
	/** maps as loaded (raw: large GeoJSON must not be deep-proxied) */
	let loaded = $state.raw<Record<string, LoadedMap>>({});
	let election = $state('pres-2020');
	const SHADINGS = [
		{ id: 'solid', label: 'Solid', hint: 'Full color for whoever wins' },
		{ id: 'tiers', label: 'Tiers', hint: 'Safe / Likely / Lean / Tilt: 15+, 8-15, 3-8, <3 point lead' },
		{ id: 'gradient', label: 'Gradient', hint: 'Fades smoothly toward a tie; full color at a 25+ point lead' }
	] as const;
	type Shading = (typeof SHADINGS)[number]['id'];
	let shading = $state<Shading>('tiers');
	/** every map with region results taken from the selected election */
	let maps = $derived(Object.fromEntries(Object.entries(loaded).map(([id, m]) => [id, withElection(m, election)])));
	let currentId = $state('');
	let swing = $state(0);
	let overrides = $state<Record<string, Record<string, Override>>>({});
	let focusGroup = $state<string | null>(null);
	let parties = $state<Party[]>(coreParties());
	let hover = $state<{ r: Region; x: number; y: number } | null>(null);
	let importing = $state(false);
	/** YAPMS-style brush: a party id or 'auto' */
	let brush = $state('D');
	let error = $state('');
	let loading = $state(false);
	let headerH = $state(56);

	let active = $derived(parties);
	let twoParty = $derived(parties.length === 2);
	let byId = $derived(Object.fromEntries(parties.map((p) => [p.id, p])) as Record<string, Party>);
	let map = $derived(maps[currentId]);
	let electionInfo = $derived(map?.elections.find((e) => e.id === election));
	let ov = $derived(overrides[currentId] ?? {});

	function ctxFor(m: LoadedMap): SimContext {
		return buildContext(m.regions, active, swing, overrides[m.manifest.id] ?? {});
	}
	let ctx = $derived(map ? ctxFor(map) : null);
	let t = $derived(map && ctx ? tally(map.regions, ctx) : null);
	let majority = $derived(t ? Math.floor(t.total / 2) + 1 : 0);
	let groups = $derived(map ? [...new Set(map.regions.map((r) => r.group).filter(Boolean))].sort() : []);
	let hasBaseline = $derived(!!map?.regions.some((r) => r.demShare !== null));
	let groupTally = $derived(
		focusGroup && map && ctx ? tally(map.regions.filter((r) => r.group === focusGroup), ctx) : null
	);
	// keep the brush valid when parties change
	$effect(() => {
		if (brush !== 'auto' && !active.some((p) => p.id === brush)) brush = 'D';
	});

	function ranked(tl: Tally) {
		return active
			.map((p) => ({ p, n: tl.seats[p.id] ?? 0 }))
			.sort((a, b) => b.n - a.n);
	}
	function status(tl: Tally): string {
		const [top, second] = ranked(tl);
		if (!top || !top.n) return '';
		const need = Math.floor(tl.total / 2) + 1;
		if (top.n >= need) return `${top.p.name} majority of ${top.n * 2 - tl.total}`;
		if (second && top.n === second.n) return `Hung: ${top.p.name} and ${second.p.name} tied`;
		return `Hung: ${top.p.name} largest, ${need - top.n} short of a majority`;
	}

	// Compare every loaded map, restricted to groups present in the current map.
	let comparison = $derived.by(() => {
		if (!map) return [];
		const scope = new Set(map.regions.filter((r) => r.demShare !== null).map((r) => r.group));
		return Object.values(maps)
			.filter((m) => m.regions.some((r) => r.demShare !== null))
			.map((m) => {
				const rs = m.regions.filter((r) => scope.has(r.group));
				const c = buildContext(rs, active, swing, overrides[m.manifest.id] ?? {});
				return { id: m.manifest.id, name: m.manifest.name, t: tally(rs, c), tip: twoParty ? tippingSwing(rs) : null };
			});
	});
	let compareCols = $derived(
		spectrumOrder(active).filter((p) => p.core || comparison.some((c) => c.t.seats[p.id]))
	);

	// ---------- persistence: URL hash (shareable) + localStorage (parties) ----------
	function encodeHash(): string {
		const o = Object.entries(ov).map(([k, v]) => `${k}:${v.p}${v.l}`).join(',');
		const p = new URLSearchParams({ map: currentId, election, swing: String(swing) });
		if (o) p.set('o', o);
		if (focusGroup) p.set('focus', focusGroup);
		if (!twoParty) p.set('parties', JSON.stringify(parties.map(({ core, ...rest }) => rest)));
		return p.toString();
	}

	function parseOverride(v: string): Override | null {
		const m = v.match(/^(D|R|p\d{1,3})([1-4])$/);
		return m ? { p: m[1], l: Number(m[2]) as Level } : null;
	}

	function readHash() {
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
		try { localStorage.setItem('yayapms.parties.v2', snap); } catch { /* storage unavailable */ }
	});

	onMount(async () => {
		try {
			const saved = JSON.parse(localStorage.getItem('yayapms.parties.v2') ?? 'null');
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
		if (first) selectMap(first);
	});

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

	// ---------- interaction ----------
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

	// Swing slider: discrete stops, evenly spaced on the bar, finer near 0.
	const STOPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 25, 30, 35, 40];
	const SWING_VALUES = [...STOPS.map((v) => -v).reverse(), 0, ...STOPS];
	const SWING_MAX = STOPS[STOPS.length - 1];
	const SWING_LABELS = new Set([-20, -10, -5, 0, 5, 10, 20]);
	const swingIndex = (s: number) =>
		SWING_VALUES.reduce((best, v, i) => (Math.abs(v - s) < Math.abs(SWING_VALUES[best] - s) ? i : best), 0);
	const stopPct = (i: number) => (i / (SWING_VALUES.length - 1)) * 100;
	const tickLabel = (s: number) => (s === 0 ? '0' : `${s > 0 ? 'D' : 'R'}+${Math.abs(s)}`);

	// Color strength (%) for a result under each shading mode.
	const LEVEL_PCT = [0, 28, 48, 72, 100];
	const LEVEL_MARGIN = [0, 1.5, 5.5, 11.5, 20]; // typical margin per rating level, for manual ratings
	function strength(o: Outcome): number {
		if (shading === 'solid') return 100;
		if (shading === 'tiers') return LEVEL_PCT[o.level];
		const m = o.margin ?? LEVEL_MARGIN[o.level];
		return 12 + 88 * Math.min(1, Math.abs(m) / 25); // fades toward a tie
	}

	function fill(r: Region): string {
		if (!ctx) return 'var(--unrated)';
		const o = outcome(r, ctx);
		if (o.unrated || o.winner === null) return 'var(--unrated)';
		const c = byId[o.winner]?.color ?? '#888888';
		return `color-mix(in oklab, ${c} ${strength(o)}%, var(--mix-base))`;
	}

	function ratingText(o: Outcome): string {
		if (o.unrated || o.winner === null) return 'Unrated';
		return `${RATING_NAMES[o.level]} ${byId[o.winner]?.name ?? o.winner}`;
	}

	function fmtMargin(m: number): string {
		return m === 0 ? 'Even' : `${m > 0 ? 'D' : 'R'}+${Math.abs(m).toFixed(1)}`;
	}

	function onImport(m: LoadedMap) {
		loaded = { ...loaded, [m.manifest.id]: m };
		index = [...index, { id: m.manifest.id, name: `${m.manifest.name} (imported)` }];
		selectMap(m.manifest.id);
		focusGroup = null;
		importing = false;
	}

	interface StateReport {
		seats: number;
		statewide_dem_share_2020?: number;
		chosen?: { dem_seats_2020: number; max_pop_deviation?: number };
		ensemble?: { samples?: number; dem_seats_2020: Record<string, number> };
	}
	let report = $derived(
		focusGroup && map?.report ? (map.report as Record<string, StateReport>)[focusGroup] : undefined
	);
	let brushes = $derived([
		...spectrumOrder(active).map((p) => ({ id: p.id, label: p.name, color: p.color, n: t?.seats[p.id] })),
		{ id: 'auto', label: hasBaseline ? 'Auto (baseline)' : 'Clear', color: 'transparent', n: undefined }
	]);
</script>

<svelte:head><title>yayapms</title></svelte:head>

<header bind:clientHeight={headerH}>
	<h1>yayapms</h1>
	<label class="pick">Districts
		<select value={currentId} onchange={(e) => selectMap(e.currentTarget.value)}>
			{#each index as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
		</select>
	</label>
	{#if map?.elections.length}
		<label class="pick">Election
			<select bind:value={election}>
				{#each map.elections as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
			</select>
		</label>
	{/if}
	<select value={focusGroup ?? ''} onchange={(e) => (focusGroup = e.currentTarget.value || null)} aria-label="Jump to state">
		<option value="">Jump to state…</option>
		{#each groups as g (g)}<option value={g}>{g}</option>{/each}
	</select>
	<button type="button" onclick={() => (importing = true)}>Import map…</button>
	{#if loading}<span class="muted">loading…</span>{/if}
</header>

{#if error}<p class="error banner">{error}</p>{/if}

<main style:--header-h="{headerH}px">
	<section class="map">
		{#if map}
			<div class="legend" role="radiogroup" aria-label="Paint with">
				{#each brushes as b (b.id)}
					<button
						type="button"
						role="radio"
						aria-checked={brush === b.id}
						class:active={brush === b.id}
						onclick={() => (brush = b.id)}
					>
						<span class="swatch" class:auto={b.id === 'auto'} style:background={b.color}></span>
						{b.label}
						{#if b.n !== undefined}<b>{b.n}</b>{/if}
					</button>
				{/each}
			</div>
			<MapView
				{map}
				{fill}
				{focusGroup}
				onpick={pick}
				onhover={(r, x, y) => (hover = r ? { r, x, y } : null)}
				onunfocus={() => (focusGroup = null)}
			/>
			<div class="shading" role="radiogroup" aria-label="Shading">
				<span class="muted small">Shading</span>
				{#each SHADINGS as x (x.id)}
					<button type="button" role="radio" aria-checked={shading === x.id} class:active={shading === x.id} title={x.hint} onclick={() => (shading = x.id)}>{x.label}</button>
				{/each}
			</div>
			<p class="muted small">
				Click to paint, again to cycle Safe → Tilt · right-click resets · scroll/drag to zoom/pan · Esc zooms out
			</p>
		{/if}
	</section>

	<aside>
		{#if t && map}
			<div class="seatbar" role="img" aria-label={ranked(t).map((x) => `${x.n} ${x.p.name}`).join(', ')}>
				{#each spectrumOrder(active) as p (p.id)}
					{#if p.id !== 'R'}<div style:flex-grow={t.seats[p.id] ?? 0} style:background={p.color}></div>{/if}
				{/each}
				<div style:flex-grow={t.unrated} style:background="var(--unrated)"></div>
				<div style:flex-grow={t.seats.R ?? 0} style:background={byId.R?.color}></div>
				<span class="majority" style:left="{(majority / t.total) * 100}%"></span>
			</div>
			<p class="status">{status(t)}</p>
			<ul class="results">
				{#each ranked(t) as { p, n } (p.id)}
					<li><span class="swatch" style:background={p.color}></span>{p.name}<b>{n}</b></li>
				{/each}
				{#if t.unrated}
					<li title="No result for this election and no manual rating">
						<span class="swatch" style:background="var(--unrated)"></span>Unrated<b>{t.unrated}</b>
					</li>
				{/if}
				<li class="total">Total<b>{t.total}</b></li>
			</ul>
			<p class="muted small">{majority} for a majority</p>

			{#if hasBaseline}
				<label class="swing">
					<span>D/R swing vs. {electionInfo?.label ?? 'baseline'}: <b>{fmtMargin(swing)}</b></span>
					<input
						type="range"
						min="0"
						max={SWING_VALUES.length - 1}
						step="1"
						value={swingIndex(swing)}
						oninput={(e) => (swing = SWING_VALUES[Number(e.currentTarget.value)])}
					/>
				</label>
				<div class="ticks">
					{#each SWING_VALUES as v, i (v)}
						<span class="dot" class:major={SWING_LABELS.has(v)} style:left="{stopPct(i)}%"></span>
						{#if SWING_LABELS.has(v)}
							<button type="button" style:left="{stopPct(i)}%" class:on={swing === v} onclick={() => (swing = v)}>{tickLabel(v)}</button>
						{/if}
					{/each}
				</div>
			{/if}
			{#if Object.keys(ov).length}
				<button type="button" class="link" onclick={() => (overrides[currentId] = {})}>clear {Object.keys(ov).length} manual ratings</button>
			{/if}

			<h3>Parties</h3>
			<PartyPanel bind:parties {groups} />

			{#if comparison.length > 1}
				<h3>Compare maps</h3>
				<table>
					<thead>
						<tr>
							<th>Map</th>
							{#each compareCols as p (p.id)}<th title={p.name}><span class="swatch sm" style:background={p.color}></span></th>{/each}
							{#if twoParty}<th title="Uniform swing needed for a {byId.D?.name} majority">Tipping</th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each comparison as c (c.id)}
							<tr class:current={c.id === currentId}>
								<td>{c.name}</td>
								{#each compareCols as p (p.id)}<td>{c.t.seats[p.id] ?? 0}</td>{/each}
								{#if twoParty}<td>{c.tip === null ? '—' : fmtMargin(c.tip)}</td>{/if}
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="muted small">
					Same swing and parties on every map, limited to states in the current map.{#if twoParty}
						Tipping = D/R swing at which {byId.D?.name}s win a majority.{/if}
				</p>
			{/if}

			{#if focusGroup && groupTally}
				<h3>{focusGroup}</h3>
				<p>
					{ranked(groupTally).filter((x) => x.n).map((x) => `${x.n} ${x.p.name}`).join(' · ')} of {groupTally.total}
				</p>
				{#if report?.ensemble}
					<p class="muted small">
						ReCom ensemble ({report.ensemble.samples} plans), {byId.D?.name} seats at the 2020 baseline (two-party):
					</p>
					<div class="hist">
						{#each Object.entries(report.ensemble.dem_seats_2020) as [seats, n] (seats)}
							{@const max = Math.max(...Object.values(report.ensemble.dem_seats_2020))}
							<div class:chosen={Number(seats) === report.chosen?.dem_seats_2020}>
								<span style:height="{(n / max) * 48}px" style:background={byId.D?.color}></span>
								<small>{seats}</small>
							</div>
						{/each}
					</div>
					<p class="muted small">Outlined bar = this map's plan. Statewide 2020: {fmtMargin(margin(report.statewide_dem_share_2020 ?? 0.5, 0))}.</p>
				{/if}
				<button type="button" class="link" onclick={() => (focusGroup = null)}>back to national</button>
			{/if}

			{#if map.manifest.description}
				<h3>About this map</h3>
				<p class="muted small">{map.manifest.description}</p>
			{/if}
			{#if electionInfo}
				<h3>About this election</h3>
				<p class="muted small">
					{electionInfo.label}{electionInfo.candidates ? ` (${Object.values(electionInfo.candidates).join(' vs. ')})` : ''}.
					{electionInfo.source ?? ''}
				</p>
				{#if electionInfo.credit}<p class="small"><b>{electionInfo.credit}</b></p>{/if}
			{/if}
		{/if}
	</aside>
</main>

{#if hover && ctx}
	{@const o = outcome(hover.r, ctx)}
	<div class="tip" style:left="{hover.x + 14}px" style:top="{hover.y + 14}px">
		<b>{hover.r.label}</b>
		{#if o.shares}
			{#if twoParty && hover.r.demShare !== null}
				<div>2020: {fmtMargin(margin(hover.r.demShare, 0))}{swing ? ` → ${fmtMargin(margin(hover.r.demShare, swing))}` : ''}</div>
			{:else}
				{#each Object.entries(o.shares).sort((a, b) => b[1] - a[1]) as [id, v] (id)}
					<div class="share"><span class="swatch sm" style:background={byId[id]?.color}></span>{byId[id]?.name ?? id}<span>{(v * 100).toFixed(1)}%</span></div>
				{/each}
			{/if}
		{/if}
		<div>{ratingText(o)}{o.manual ? ' (manual)' : ''}</div>
		{#if hover.r.seats !== 1}<div>{hover.r.seats} seats</div>{/if}
	</div>
{/if}

{#if importing}
	<ImportDialog onload={onImport} onclose={() => (importing = false)} />
{/if}

<style>
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		padding: 8px 16px;
		border-bottom: 1px solid var(--border);
	}
	h1 {
		font-size: 1.15rem;
		margin: 0 8px 0 0;
		letter-spacing: -0.01em;
	}
	main {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 16px;
		padding: 12px 16px;
		max-width: 1500px;
		margin: 0 auto;
	}
	/* Side-by-side layout fits one screen: map scaled to the window height, sidebar scrolls itself.
	   150px = legend + shading row + hint + padding around the map. */
	@media (min-width: 861px) {
		main {
			height: calc(100dvh - var(--header-h));
		}
		.map {
			--map-max-w: calc((100dvh - var(--header-h) - 150px) * 975 / 610);
			min-height: 0;
		}
		aside {
			overflow-y: auto;
			min-height: 0;
			padding-right: 4px;
		}
	}
	@media (max-width: 860px) {
		main {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	h3 {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
		margin: 14px 0 6px;
	}
	.seatbar {
		position: relative;
		display: flex;
		height: 22px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--unrated);
	}
	.seatbar div {
		flex-basis: 0;
	}
	.majority {
		position: absolute;
		top: -2px;
		bottom: -2px;
		width: 2px;
		background: var(--fg);
		transform: translateX(-1px);
	}
	.swing {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 16px;
		font-size: 0.9rem;
	}
	/* Custom slider so the thumb geometry is exact: its center travels from THUMB/2 to
	   width - THUMB/2, and the tick row is inset by the same amount. */
	.swing input {
		--thumb: 14px;
		-webkit-appearance: none;
		appearance: none;
		width: 100%;
		height: var(--thumb);
		margin: 0;
		background: none;
		cursor: pointer;
	}
	.swing input::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
		background: var(--border);
	}
	.swing input::-moz-range-track {
		height: 4px;
		border-radius: 2px;
		background: var(--border);
	}
	.swing input::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: var(--thumb);
		height: var(--thumb);
		margin-top: calc(2px - var(--thumb) / 2);
		border-radius: 50%;
		background: var(--fg);
		border: 2px solid var(--surface);
		box-sizing: border-box;
	}
	.swing input::-moz-range-thumb {
		width: var(--thumb);
		height: var(--thumb);
		border-radius: 50%;
		background: var(--fg);
		border: 2px solid var(--surface);
		box-sizing: border-box;
	}
	.swing input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.ticks {
		position: relative;
		height: 30px;
		margin: 4px 7px 4px; /* 7px = half of --thumb */
	}
	.ticks .dot {
		position: absolute;
		top: 0;
		width: 3px;
		height: 3px;
		border-radius: 50%;
		background: var(--muted);
		transform: translateX(-50%);
		opacity: 0.6;
	}
	.ticks .dot.major {
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
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	th,
	td {
		text-align: left;
		padding: 4px 6px;
		border-bottom: 1px solid var(--border);
	}
	td:not(:first-child),
	th:not(:first-child) {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	tr.current td {
		font-weight: 600;
	}
	.hist {
		display: flex;
		align-items: flex-end;
		gap: 4px;
		height: 66px;
	}
	.hist div {
		display: flex;
		flex-direction: column;
		align-items: center;
		flex: 1;
		max-width: 36px;
	}
	.hist span {
		width: 100%;
		border-radius: 2px 2px 0 0;
		opacity: 0.55;
	}
	.hist .chosen span {
		opacity: 1;
		outline: 2px solid var(--fg);
	}
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
	.pick {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.shading {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 8px;
	}
	.shading span {
		margin-right: 4px;
	}
	.shading button {
		padding: 3px 10px;
		font-size: 0.85rem;
	}
	.shading button.active {
		background: var(--fg);
		color: var(--bg);
		border-color: var(--fg);
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 10px;
	}
	.legend button {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		border-radius: 999px;
	}
	.legend button.active {
		border-color: var(--fg);
		box-shadow: inset 0 0 0 1px var(--fg);
	}
	.legend b {
		font-variant-numeric: tabular-nums;
	}
	.swatch {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		flex: none;
	}
	.swatch.auto {
		border: 2px dashed var(--muted);
	}
	.status {
		font-weight: 600;
		margin: 8px 0 4px;
	}
	.results {
		list-style: none;
		padding: 0;
		margin: 0 0 4px;
	}
	.results li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 3px 0;
	}
	.results li.total {
		border-top: 1px solid var(--border);
		margin-top: 2px;
		padding-top: 5px;
		color: var(--muted);
	}
	.results b {
		margin-left: auto;
		font-size: 1.15rem;
		font-variant-numeric: tabular-nums;
	}
	.swatch.sm {
		width: 10px;
		height: 10px;
		display: inline-block;
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
	.banner {
		margin: 8px 16px;
	}
</style>
