import type { CellData, LoadedMap, Region } from './types';

/**
 * Demographic swings. Each region's electorate is split into cells (age x race x edu x sex);
 * a group setting applies to every cell in that group, and settings on different dimensions
 * stack: vote swings add, turnout changes multiply.
 *   vote:    margin points toward D (+) or R (-) for the group's voters
 *   turnout: % change in the group's turnout (capped at 99.5% of its citizen voting-age pop)
 * Results change *relative to* the region's real result, so with no swings nothing moves.
 */
export interface DemoSwing {
	vote: Record<string, Record<string, number>>;
	turnout: Record<string, Record<string, number>>;
}

export function emptySwing(): DemoSwing {
	return { vote: {}, turnout: {} };
}

export function isActive(s: DemoSwing): boolean {
	return [s.vote, s.turnout].some((m) => Object.values(m).some((g) => Object.values(g).some((v) => v !== 0)));
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

/** per-cell multipliers/shifts for a swing setting */
function cellEffects(labels: Record<string, string>[], s: DemoSwing) {
	return labels.map((l) => {
		let shift = 0;
		let mult = 1;
		for (const [dim, g] of Object.entries(l)) {
			shift += s.vote[dim]?.[g] ?? 0;
			mult *= 1 + (s.turnout[dim]?.[g] ?? 0) / 100;
		}
		return { shift: shift / 200, mult };
	});
}

/** Totals for one region's cells after a swing: voters and Dem votes. */
function swungTotals(cells: number[], n: number, fx: { shift: number; mult: number }[]) {
	let V = 0, D = 0;
	for (let i = 0; i < n; i++) {
		const cv = cells[i], vo = cells[n + i], de = cells[2 * n + i];
		if (vo <= 0) continue;
		const v2 = Math.min(vo * fx[i].mult, cv * 0.995 || vo * fx[i].mult);
		const q = Math.min(1, Math.max(0, de / vo + fx[i].shift));
		V += v2;
		D += v2 * q;
	}
	return { V, D };
}

/** The map with each region's demShare/votes moved by the demographic swing. */
export function applyDemographics(m: LoadedMap, cellData: CellData | undefined, s: DemoSwing): LoadedMap {
	if (!cellData || !isActive(s)) return m;
	const labels = cellLabels(cellData);
	const n = labels.length;
	const fx = cellEffects(labels, s);
	const none = labels.map(() => ({ shift: 0, mult: 1 }));
	return {
		...m,
		regions: m.regions.map((r) => {
			if (!r.cells || r.demShare === null) return r;
			const base = swungTotals(r.cells, n, none);
			const now = swungTotals(r.cells, n, fx);
			if (base.V <= 0 || now.V <= 0) return r;
			const demShare = Math.min(1, Math.max(0, r.demShare + now.D / now.V - base.D / base.V));
			return { ...r, demShare, votes: r.votes * (now.V / base.V) };
		})
	};
}

export interface GroupStat {
	group: string;
	/** share of all voters (with the swing) */
	voterShare: number;
	/** two-party D share before / after the swing */
	demBefore: number;
	demAfter: number;
	turnoutBefore: number;
	turnoutAfter: number;
}

/** Electorate summary per group of one dimension, over the given regions. */
export function groupStats(regions: Region[], cellData: CellData | undefined, dim: string, s: DemoSwing): GroupStat[] {
	if (!cellData) return [];
	const labels = cellLabels(cellData);
	const n = labels.length;
	const fx = cellEffects(labels, s);
	const groups = cellData.dims[dim];
	const acc = groups.map(() => ({ cv: 0, v0: 0, d0: 0, v1: 0, d1: 0 }));
	let total = 0;
	for (const r of regions) {
		if (!r.cells) continue;
		for (let i = 0; i < n; i++) {
			const cv = r.cells[i], vo = r.cells[n + i], de = r.cells[2 * n + i];
			if (vo <= 0) continue;
			const a = acc[groups.indexOf(labels[i][dim])];
			const v1 = Math.min(vo * fx[i].mult, cv * 0.995 || vo * fx[i].mult);
			const q1 = Math.min(1, Math.max(0, de / vo + fx[i].shift));
			a.cv += cv; a.v0 += vo; a.d0 += de; a.v1 += v1; a.d1 += v1 * q1;
			total += v1;
		}
	}
	return groups.map((g, i) => {
		const a = acc[i];
		return {
			group: g,
			voterShare: total ? a.v1 / total : 0,
			demBefore: a.v0 ? a.d0 / a.v0 : 0,
			demAfter: a.v1 ? a.d1 / a.v1 : 0,
			turnoutBefore: a.cv ? a.v0 / a.cv : 0,
			turnoutAfter: a.cv ? a.v1 / a.cv : 0
		};
	});
}

const NAME = /^[A-Za-z0-9 +\-]{1,30}$/;

/** Validate an untrusted swing (URL hash / storage) against known dimensions. */
export function sanitizeSwing(raw: unknown, dims: Record<string, string[]>, limits: { vote: number; turnout: number }): DemoSwing {
	const out = emptySwing();
	if (!raw || typeof raw !== 'object') return out;
	for (const kind of ['vote', 'turnout'] as const) {
		const src = (raw as Record<string, unknown>)[kind];
		if (!src || typeof src !== 'object') continue;
		for (const [dim, groups] of Object.entries(src as Record<string, unknown>)) {
			if (!dims[dim] || !groups || typeof groups !== 'object') continue;
			for (const [g, v] of Object.entries(groups as Record<string, unknown>)) {
				if (!NAME.test(g) || !dims[dim].includes(g) || typeof v !== 'number' || !Number.isFinite(v)) continue;
				(out[kind][dim] ??= {})[g] = Math.max(-limits[kind], Math.min(limits[kind], v));
			}
		}
	}
	return out;
}
