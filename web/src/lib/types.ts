import type { Feature, FeatureCollection, Geometry } from 'geojson';

/** manifest.json of a map pack. Only `id`, `name`, `file` are required. */
export interface MapManifest {
	id: string;
	name: string;
	description?: string;
	/** GeoJSON (.geojson/.json) or TopoJSON (.topojson / type "Topology") file, relative to the manifest */
	file: string;
	/** For TopoJSON: which object to use (default: first) */
	topoObject?: string;
	/** albersUsa (US with AK/HI insets), mercator, equalEarth, or identity (pre-projected planar coords) */
	projection?: 'albersUsa' | 'mercator' | 'equalEarth' | 'identity';
	idProperty?: string;
	labelProperty?: string;
	/** groups regions (e.g. by state) for zooming and subtotals */
	groupProperty?: string;
	/** seats per region (default 1) */
	seatsProperty?: string;
	/** elections with results for these regions; each enables the swing simulation */
	elections?: ElectionRef[];
	/** optional outline overlay (e.g. state borders) drawn on top, not clickable */
	bordersFile?: string;
	/** optional extra JSON (e.g. generation report) shown in the info panel */
	reportFile?: string;
	/** optional local factors per region and region adjacency (LocalData), relative to the manifest */
	localFile?: string;
}

export interface ElectionRef {
	id: string;
	label: string;
	/** JSON file relative to the manifest: {"results": {regionId: {party: votes, ...}}} */
	file: string;
	/** the election's parties, in order (default: the parties in its results) */
	parties?: string[];
	candidates?: Record<string, string>;
	source?: string;
	/** attribution that must be shown when displayed */
	credit?: string;
	/** optional demographic cells file: per region, cvap | voters | dem for every cell */
	cellsFile?: string;
}

/** Demographic cells for one election: cell i is the i-th combination of `dims` in `order`. */
export interface CellData {
	dims: Record<string, string[]>;
	order: string[];
	/** the election's parties (default D, R): the last one is "everyone else" in `results` */
	parties?: string[];
	/** per region: [cvap x N, voters x N, then votes x N for each party but the last] for N cells.
	 *  On disk this may instead be a sparse binary file (`bin`, see loader.decodeCells). */
	results: Record<string, number[]>;
}

/** Local factors (traits of a place, e.g. religion, income) per region, and which regions border which. */
export interface LocalData {
	factors: { id: string; label: string }[];
	/** per region: one value per factor (shares 0..1, or log10 density) */
	values: Record<string, number[]>;
	neighbors: Record<string, string[]>;
}

export interface Election extends Omit<ElectionRef, 'file' | 'cellsFile'> {
	results: Record<string, Record<string, number>>;
	cells?: CellData;
}

export interface Region {
	id: string;
	label: string;
	group: string;
	seats: number;
	/** votes for the selected election's parties (weights for averages); 0 if no result */
	votes: number;
	/** demographic cells for the selected election, if available */
	cells?: number[];
	/** votes per party of the selected election (its parties: loader.electionParties); absent if no result */
	baseline?: Record<string, number>;
	feature: Feature<Geometry>;
}

export interface LoadedMap {
	manifest: MapManifest;
	regions: Region[];
	collection: FeatureCollection<Geometry>;
	elections: Election[];
	borders?: FeatureCollection<Geometry>;
	report?: unknown;
	local?: LocalData;
}

/** a party's appeal to the voters matching `filter`, in points of its share of them at the
 *  baseline (see model.appealShift); appeals add up across every group a voter is in */
export interface Appeal {
	/** per dimension, the allowed groups (see demographics.ts); {} = everyone */
	filter: Record<string, string[]>;
	points: number;
	/** older links stored a share target (%) instead; it is fitted to points once the map loads */
	target?: number;
}

export interface Party {
	/** parties of an election's data have its ids (e.g. "D", "R"); added ones "p1", "p2", ... */
	id: string;
	name: string;
	color: string;
	/** a party of the elections' data (its votes come from real results); others are added */
	core?: boolean;
	/** added parties: base vote share in %, where it runs: exact with even pulls and no appeals */
	share: number;
	/** added parties: "pulls from", relative weight 0..100 per party of the election's data
	 *  (how strongly it attracts that party's voters); missing or equal weights = evenly */
	pulls?: Record<string, number>;
	/** extras only: groups (states) it contests; empty = everywhere */
	states: string[];
	/** its appeal in voter groups */
	appeals: Appeal[];
}

/** 1..4 = Tilt, Lean, Likely, Safe */
export type Level = 1 | 2 | 3 | 4;
export const RATING_NAMES: Record<Level, string> = { 4: 'Safe', 3: 'Likely', 2: 'Lean', 1: 'Tilt' };

/** Manual rating: party id + level */
export interface Override {
	p: string;
	l: Level;
}

export interface Outcome {
	/** winning party id, or null if unrated */
	winner: string | null;
	level: Level;
	unrated: boolean;
	manual: boolean;
	/** simulated vote shares (0..1) by party id, if the region has a baseline */
	shares: Record<string, number> | null;
	/** winner minus runner-up, in points */
	margin: number | null;
}

/** per-state entry of a fair map's report.json (written by pipeline/generate.py) */
export interface StateReport {
	seats: number;
	statewide_dem_share_2020?: number;
	chosen?: { dem_seats_2020: number; max_pop_deviation?: number };
	ensemble?: { samples?: number; dem_seats_2020: Record<string, number> };
}
