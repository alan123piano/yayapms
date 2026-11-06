import type { CellData } from './types';

/**
 * Voter groups and voter-group edits (applied by model.ts). Each region's electorate is split
 * into cells (age x race x edu x sex).
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

/** a voter group offered in pickers: every single group, plus the custom groups */
export interface GroupOption {
	key: string;
	label: string;
	/** dimension name for single groups, e.g. "Age" */
	dim?: string;
	filter: Filter;
	custom: boolean;
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

export type Effect = { shift: number; mult: number };

/** per-cell D-share shift (share units) and turnout multiplier for a swing setting */
export function cellEffects(labels: Record<string, string>[], s: DemoSwing): Effect[] {
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
