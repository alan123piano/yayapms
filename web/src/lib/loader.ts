import { geoArea } from 'd3-geo';
import { feature as topoFeature } from 'topojson-client';
import type { Feature, FeatureCollection, Geometry, Polygon, MultiPolygon } from 'geojson';
import type { Topology } from 'topojson-specification';
import type { CellData, Election, LoadedMap, MapManifest, Region } from './types';

const MAX_BYTES = 50 * 1024 * 1024;

/** d3-geo wants clockwise exterior rings; RFC 7946 GeoJSON is the opposite. Fix per polygon. */
function fixWinding(f: Feature<Geometry>): Feature<Geometry> {
	const g = f.geometry;
	if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return f;
	const polys: number[][][][] = g.type === 'Polygon' ? [(g as Polygon).coordinates] : (g as MultiPolygon).coordinates;
	for (const poly of polys) {
		const probe: Feature<Polygon> = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: poly } };
		if (geoArea(probe) > 2 * Math.PI) for (const ring of poly) ring.reverse();
	}
	return f;
}

/** Parse GeoJSON or TopoJSON text into a FeatureCollection. Data only — never evaluated. */
export function parseGeo(text: string, topoObject?: string): FeatureCollection<Geometry> {
	if (text.length > MAX_BYTES) throw new Error('File too large (50 MB max)');
	const data = JSON.parse(text);
	if (data?.type === 'Topology') {
		const topo = data as Topology;
		const name = topoObject ?? Object.keys(topo.objects)[0];
		if (!topo.objects[name]) throw new Error(`TopoJSON has no object "${name}"`);
		const fc = topoFeature(topo, topo.objects[name]) as FeatureCollection<Geometry> | Feature<Geometry>;
		return fc.type === 'FeatureCollection' ? fc : { type: 'FeatureCollection', features: [fc] };
	}
	if (data?.type === 'FeatureCollection' && Array.isArray(data.features)) return data;
	if (data?.type === 'Feature') return { type: 'FeatureCollection', features: [data] };
	throw new Error('Not GeoJSON (FeatureCollection/Feature) or TopoJSON (Topology)');
}

/** Property names present on features, for the import field picker. */
export function propertyNames(fc: FeatureCollection): string[] {
	const names = new Set<string>();
	for (const f of fc.features.slice(0, 200)) for (const k of Object.keys(f.properties ?? {})) names.add(k);
	return [...names];
}

/** Best-guess manifest fields (and vote columns) for an imported file without a manifest. */
export function guessManifest(fc: FeatureCollection, name: string): { manifest: MapManifest; dem?: string; rep?: string } {
	const props = propertyNames(fc);
	const pick = (...cands: string[]) => props.find((p) => cands.includes(p.toLowerCase()));
	return {
		manifest: {
			id: `import-${Date.now()}`,
			name,
			file: '',
			projection: 'mercator',
			idProperty: pick('id', 'geoid', 'district', 'cd', 'code'),
			labelProperty: pick('name', 'label', 'namelsad', 'district_name'),
			groupProperty: pick('state', 'statefp', 'region', 'group', 'province'),
			seatsProperty: pick('seats', 'seat', 'ev', 'electoral_votes')
		},
		dem: pick('dem', 'd', 'dem_votes', 'g20predbid', 'g24predhar', 'votes_dem'),
		rep: pick('rep', 'r', 'rep_votes', 'g20prertru', 'g24prertru', 'votes_rep')
	};
}

interface BuildOptions {
	elections?: Election[];
	report?: unknown;
	borders?: FeatureCollection<Geometry>;
	/** imported files: build an election from these feature properties */
	voteProps?: { dem: string; rep: string };
}

export function buildMap(manifest: MapManifest, fc: FeatureCollection<Geometry>, opts: BuildOptions = {}): LoadedMap {
	const seen = new Set<string>();
	const imported: Election | null = opts.voteProps
		? { id: 'imported', label: 'Imported results', results: {} }
		: null;
	const regions: Region[] = fc.features.map((f, i) => {
		fixWinding(f);
		const p = f.properties ?? {};
		let id = String(manifest.idProperty ? p[manifest.idProperty] ?? i : f.id ?? i);
		if (seen.has(id)) id = `${id}#${i}`;
		seen.add(id);
		if (imported && opts.voteProps) {
			imported.results[id] = { D: Number(p[opts.voteProps.dem]), R: Number(p[opts.voteProps.rep]) };
		}
		const seats = Number(manifest.seatsProperty ? p[manifest.seatsProperty] : 1);
		return {
			id,
			label: String(manifest.labelProperty ? p[manifest.labelProperty] ?? id : id),
			group: String(manifest.groupProperty ? p[manifest.groupProperty] ?? '' : ''),
			seats: Number.isFinite(seats) && seats >= 0 ? seats : 1,
			demShare: null,
			votes: 0,
			feature: f
		};
	});
	opts.borders?.features.forEach(fixWinding);
	const elections = imported ? [imported] : (opts.elections ?? []);
	return withElection({ manifest, regions, collection: fc, elections, report: opts.report, borders: opts.borders }, elections[0]?.id);
}

/** The same map with each region's demShare/votes taken from the given election (null if absent). */
export function withElection(m: LoadedMap, electionId: string | undefined): LoadedMap {
	const el = m.elections.find((e) => e.id === electionId);
	return {
		...m,
		regions: m.regions.map((r) => {
			const v = el?.results[r.id];
			const d = Number(v?.D), rep = Number(v?.R);
			const ok = Number.isFinite(d) && Number.isFinite(rep) && d >= 0 && rep >= 0 && d + rep > 0;
			return { ...r, demShare: ok ? d / (d + rep) : null, votes: ok ? d + rep : 0, cells: ok ? el?.cells?.results[r.id] : undefined };
		})
	};
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return res.text();
}

const SAFE_PATH = /^[a-z0-9][a-z0-9._/-]*$/i;

/** Load a built-in pack from /maps/<id>/manifest.json */
export async function loadPack(id: string): Promise<LoadedMap> {
	if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('bad pack id');
	const base = `/maps/${id}/`;
	const manifest: MapManifest = JSON.parse(await fetchText(base + 'manifest.json'));
	const file = (f: string) => {
		if (!SAFE_PATH.test(f) || f.includes('..')) throw new Error(`bad file path in manifest: ${f}`);
		return fetchText(base + f);
	};
	const fc = parseGeo(await file(manifest.file), manifest.topoObject);
	const [report, borders, elections] = await Promise.all([
		manifest.reportFile ? file(manifest.reportFile).then(JSON.parse) : undefined,
		manifest.bordersFile ? file(manifest.bordersFile).then((t) => parseGeo(t)) : undefined,
		Promise.all(
			(manifest.elections ?? []).map(async ({ file: f, cellsFile, ...meta }) => {
				const results = JSON.parse(await file(f)).results;
				if (!results || typeof results !== 'object') throw new Error(`${f}: no results`);
				const cells = cellsFile ? (JSON.parse(await file(cellsFile)) as CellData) : undefined;
				return { ...meta, results, cells } as Election;
			})
		)
	]);
	return buildMap(manifest, fc, { report, borders, elections });
}
