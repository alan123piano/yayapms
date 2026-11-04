import type { CellData, LoadedMap, Region } from './types';

/**
 * Voter-group swings. Each region's electorate is split into cells (age x race x edu x sex).
 * A segment selects cells with a filter (per dimension, the allowed groups; a dimension left
 * out matches everyone), e.g. {age: ['18-29'], sex: ['Men']} = young men. Every segment that
 * matches a cell applies to it, and they stack: vote swings add, turnout changes multiply.
 *   vote:    margin points toward D (+) or R (-) for the segment's voters
 *   turnout: % change in how many of them vote (capped at 99.5% of citizen voting-age pop)
 * Results change *relative to* the region's real result, so with no swings nothing moves.
 */
export type Filter = Record<string, string[]>;

export interface Segment {
	/** single-group segments from the dimension tabs use "dim=group"; custom ones "c1", "c2", ... */
	id: string;
	filter: Filter;
	vote: number;
	turnout: number;
	custom?: boolean;
}

export interface DemoSwing {
	segments: Segment[];
}

export const MAX_CUSTOM_SEGMENTS = 12;

export function emptySwing(): DemoSwing {
	return { segments: [] };
}

export function isActive(s: DemoSwing): boolean {
	return s.segments.some((g) => g.vote !== 0 || g.turnout !== 0);
}

/** Canonical key for a filter (order-independent), e.g. "age=18-29&sex=Men". */
export function filterKey(f: Filter): string {
	return Object.keys(f)
		.filter((d) => f[d]?.length)
		.sort()
		.map((d) => `${d}=${[...f[d]].sort().join('|')}`)
		.join('&');
}

export function matches(label: Record<string, string>, f: Filter): boolean {
	for (const [dim, groups] of Object.entries(f)) if (groups.length && !groups.includes(label[dim])) return false;
	return true;
}

/** Human-readable filter, e.g. "18-29 · Men" or "Everyone". */
export function describe(f: Filter, order: string[]): string {
	const parts = order.filter((d) => f[d]?.length).map((d) => f[d].join(' or '));
	return parts.length ? parts.join(' · ') : 'Everyone';
}

/** for each cell, its group name in each dimension, e.g. [{age:'18-29', race:'White', ...}, ...] */
export function cellLabels(c: CellData): Record<string, string>[] {
	const out: Record<string, string>[] = [];
	const rec = (i: number, cur: Record<string, string>) => {
		if (i === c.order.length) return void out.push({ ...cur });
		for (const g of c.dims[c.order[i]]) rec(i + 1, { ...cur, [c.order[i]]: g });
	};
	rec(0, {});
	return out;
}

type Effect = { shift: number; mult: number };

/** per-cell D-share shift and turnout multiplier for a swing setting */
function cellEffects(labels: Record<string, string>[], s: DemoSwing): Effect[] {
	const live = s.segments.filter((g) => g.vote !== 0 || g.turnout !== 0);
	return labels.map((l) => {
		let shift = 0;
		let mult = 1;
		for (const g of live) {
			if (!matches(l, g.filter)) continue;
			shift += g.vote;
			mult *= 1 + g.turnout / 100;
		}
		return { shift: shift / 200, mult };
	});
}

/** One cell after a swing: [voters, Dem votes]. */
function swungCell(cells: number[], n: number, i: number, fx: Effect): [number, number] {
	const cv = cells[i], vo = cells[n + i], de = cells[2 * n + i];
	if (vo <= 0) return [0, 0];
	const v = Math.min(vo * fx.mult, cv * 0.995 || vo * fx.mult);
	return [v, v * Math.min(1, Math.max(0, de / vo + fx.shift))];
}

/** The map with each region's demShare/votes moved by the swing. */
export function applyDemographics(m: LoadedMap, cellData: CellData | undefined, s: DemoSwing): LoadedMap {
	if (!cellData || !isActive(s)) return m;
	const labels = cellLabels(cellData);
	const n = labels.length;
	const fx = cellEffects(labels, s);
	return {
		...m,
		regions: m.regions.map((r) => {
			if (!r.cells || r.demShare === null) return r;
			let V0 = 0, D0 = 0, V1 = 0, D1 = 0;
			for (let i = 0; i < n; i++) {
				const vo = r.cells[n + i];
				if (vo <= 0) continue;
				V0 += vo;
				D0 += r.cells[2 * n + i];
				const [v, d] = swungCell(r.cells, n, i, fx[i]);
				V1 += v;
				D1 += d;
			}
			if (V0 <= 0 || V1 <= 0) return r;
			const demShare = Math.min(1, Math.max(0, r.demShare + D1 / V1 - D0 / V0));
			return { ...r, demShare, votes: r.votes * (V1 / V0) };
		})
	};
}

/** Attach each filter's share of voters and D share (after the swing) to every region, keyed by filterKey. */
export function withAudiences(m: LoadedMap, cellData: CellData | undefined, s: DemoSwing, filters: Filter[]): LoadedMap {
	if (!cellData || !filters.length) return m;
	const labels = cellLabels(cellData);
	const n = labels.length;
	const fx = cellEffects(labels, s);
	const keys = filters.map(filterKey);
	const member = filters.map((f) => labels.map((l) => matches(l, f)));
	return {
		...m,
		regions: m.regions.map((r) => {
			if (!r.cells) return r;
			let V = 0;
			const acc = filters.map(() => ({ v: 0, d: 0 }));
			for (let i = 0; i < n; i++) {
				const [v, d] = swungCell(r.cells, n, i, fx[i]);
				if (!v) continue;
				V += v;
				for (let k = 0; k < filters.length; k++) if (member[k][i]) { acc[k].v += v; acc[k].d += d; }
			}
			const audiences: Record<string, { share: number; dem: number }> = {};
			acc.forEach((a, k) => (audiences[keys[k]] = { share: V ? a.v / V : 0, dem: a.v ? a.d / a.v : 0 }));
			return { ...r, audiences };
		})
	};
}

export interface GroupStat {
	/** share of all voters (with the swing) */
	voterShare: number;
	/** two-party D share before / after the swing */
	demBefore: number;
	demAfter: number;
	turnoutBefore: number;
	turnoutAfter: number;
}

/** Electorate summary for each filter, over the given regions. */
export function statsFor(regions: Region[], cellData: CellData | undefined, filters: Filter[], s: DemoSwing): GroupStat[] {
	if (!cellData) return [];
	const labels = cellLabels(cellData);
	const n = labels.length;
	const fx = cellEffects(labels, s);
	const member = filters.map((f) => labels.map((l) => matches(l, f)));
	const acc = filters.map(() => ({ cv: 0, v0: 0, d0: 0, v1: 0, d1: 0 }));
	let total = 0;
	for (const r of regions) {
		if (!r.cells) continue;
		for (let i = 0; i < n; i++) {
			const cv = r.cells[i], vo = r.cells[n + i], de = r.cells[2 * n + i];
			if (vo <= 0) continue;
			const [v1, d1] = swungCell(r.cells, n, i, fx[i]);
			total += v1;
			for (let k = 0; k < filters.length; k++) {
				if (!member[k][i]) continue;
				const a = acc[k];
				a.cv += cv; a.v0 += vo; a.d0 += de; a.v1 += v1; a.d1 += d1;
			}
		}
	}
	return acc.map((a) => ({
		voterShare: total ? a.v1 / total : 0,
		demBefore: a.v0 ? a.d0 / a.v0 : 0,
		demAfter: a.v1 ? a.d1 / a.v1 : 0,
		turnoutBefore: a.cv ? a.v0 / a.cv : 0,
		turnoutAfter: a.cv ? a.v1 / a.cv : 0
	}));
}

const NAME = /^[A-Za-z0-9 +\-]{1,30}$/;
const SEG_ID = /^([a-z]{1,10}=[A-Za-z0-9 +\-]{1,30}|c\d{1,3})$/;

/** Validate an untrusted filter against known dimensions/groups; null if unusable. */
export function sanitizeFilter(raw: unknown, dims: Record<string, string[]>): Filter | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const out: Filter = {};
	for (const [dim, groups] of Object.entries(raw as Record<string, unknown>)) {
		if (!dims[dim] || !Array.isArray(groups)) return null;
		const gs = groups.filter((g): g is string => typeof g === 'string' && NAME.test(g) && dims[dim].includes(g));
		if (gs.length) out[dim] = [...new Set(gs)];
	}
	return out;
}

/** Validate an untrusted swing (URL hash) against known dimensions. */
export function sanitizeSwing(raw: unknown, dims: Record<string, string[]>, limits: { vote: number; turnout: number }): DemoSwing {
	const out = emptySwing();
	const segs = (raw as { segments?: unknown } | null)?.segments;
	if (!Array.isArray(segs)) return out;
	const clamp = (v: unknown, lim: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0);
	for (const g of segs.slice(0, 200)) {
		if (!g || typeof g !== 'object') continue;
		const { id, filter, vote, turnout, custom } = g as Record<string, unknown>;
		const f = sanitizeFilter(filter, dims);
		if (typeof id !== 'string' || !SEG_ID.test(id) || !f || out.segments.some((x) => x.id === id)) continue;
		out.segments.push({ id, filter: f, vote: clamp(vote, limits.vote), turnout: clamp(turnout, limits.turnout), custom: custom === true || undefined });
	}
	return out;
}
