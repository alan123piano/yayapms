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
}

export interface ElectionRef {
	id: string;
	label: string;
	/** JSON file relative to the manifest: {"results": {regionId: {"D": votes, "R": votes, ...}}} */
	file: string;
	candidates?: Record<string, string>;
	source?: string;
	/** attribution that must be shown when displayed */
	credit?: string;
}

export interface Election extends Omit<ElectionRef, 'file'> {
	results: Record<string, Record<string, number>>;
}

export interface Region {
	id: string;
	label: string;
	group: string;
	seats: number;
	/** two-party Dem share 0..1 in the selected election, or null if no result */
	demShare: number | null;
	/** two-party votes in the selected election (weights for averages); 0 if unknown */
	votes: number;
	feature: Feature<Geometry>;
}

export interface LoadedMap {
	manifest: MapManifest;
	regions: Region[];
	collection: FeatureCollection<Geometry>;
	elections: Election[];
	borders?: FeatureCollection<Geometry>;
	report?: unknown;
}

export interface Party {
	/** 'D' and 'R' are the core parties; extras get ids like 'p1' */
	id: string;
	name: string;
	color: string;
	core?: boolean;
	/** extras only: target vote share in %, within its states (or nationally) */
	share: number;
	/** extras only: % of its voters drawn from D (rest from R) */
	fromD: number;
	/** extras only: groups (states) it contests; empty = everywhere */
	states: string[];
}

/** 0 = toss-up, 1..4 = Tilt, Lean, Likely, Safe */
export type Level = 0 | 1 | 2 | 3 | 4;
export const RATING_NAMES: Record<number, string> = {
	4: 'Safe', 3: 'Likely', 2: 'Lean', 1: 'Tilt', 0: 'Toss-up'
};

/** Manual rating: party id (or 'T' = toss-up) + level */
export interface Override {
	p: string;
	l: Level;
}

export interface Outcome {
	/** winning party id, or null for toss-up / unrated */
	winner: string | null;
	level: Level;
	unrated: boolean;
	manual: boolean;
	/** simulated vote shares (0..1) by party id, if the region has a baseline */
	shares: Record<string, number> | null;
	/** winner minus runner-up, in points */
	margin: number | null;
}
