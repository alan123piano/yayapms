import { RATING_THRESHOLDS as T } from './config';
import { simulate, type Basis, type Scenario, type Simulation } from './model';
import type { Level, Outcome, Override, Party, Region } from './types';

/** Two-party Dem margin in points after a uniform swing (swing in points, + = toward D). */
export function margin(demShare: number, swing: number): number {
	return (2 * demShare - 1) * 100 + swing;
}

export function levelFromMargin(m: number): Level {
	const a = Math.abs(m);
	return a < T[0] ? 1 : a < T[1] ? 2 : a < T[2] ? 3 : 4;
}

export interface SimContext {
	parties: Party[];
	overrides: Record<string, Override>;
	sim: Simulation | null;
}

/** Run the vote model (see model.ts) for these regions; national targets are over `regions`. */
export function buildContext(
	basis: Basis | undefined,
	regions: Region[],
	scenario: Scenario,
	overrides: Record<string, Override>
): SimContext {
	return { parties: scenario.parties, overrides, sim: basis ? simulate(basis, regions, scenario) : null };
}

export function shares(r: Region, ctx: SimContext): Record<string, number> | null {
	return ctx.sim?.shares.get(r.id) ?? null;
}

const UNRATED: Outcome = { winner: null, level: 1, unrated: true, manual: false, shares: null, margin: null };

export function outcome(r: Region, ctx: SimContext): Outcome {
	const sh = shares(r, ctx);
	const ov = ctx.overrides[r.id];
	if (ov && ctx.parties.some((p) => p.id === ov.p)) {
		return {
			winner: ov.p,
			level: ov.l,
			unrated: false,
			manual: true,
			shares: sh,
			margin: null
		};
	}
	if (!sh) return UNRATED;
	const ranked = Object.entries(sh).sort((a, b) => b[1] - a[1]);
	const m = (ranked[0][1] - (ranked[1]?.[1] ?? 0)) * 100;
	return { winner: ranked[0][0], level: levelFromMargin(m), unrated: false, manual: false, shares: sh, margin: m };
}

export interface Tally {
	seats: Record<string, number>;
	unrated: number;
	total: number;
}

export function tally(regions: Region[], ctx: SimContext): Tally {
	const t: Tally = { seats: {}, unrated: 0, total: 0 };
	for (const p of ctx.parties) t.seats[p.id] = 0;
	for (const r of regions) {
		const o = outcome(r, ctx);
		t.total += r.seats;
		if (o.unrated || o.winner === null) t.unrated += r.seats;
		else t.seats[o.winner] = (t.seats[o.winner] ?? 0) + r.seats;
	}
	return t;
}

/** Two-party only: smallest uniform swing (0.1 pt) giving D a majority, or null within ±40. */
export function tippingSwing(regions: Region[], ctx: SimContext): number | null {
	const leans = regions.flatMap((r) => {
		const l = ctx.sim?.lean.get(r.id);
		return l === undefined ? [] : [{ l, seats: r.seats }];
	});
	const total = leans.reduce((s, x) => s + x.seats, 0);
	if (!total) return null;
	const need = Math.floor(total / 2) + 1;
	for (let s = -400; s <= 400; s++) {
		const sw = s / 10;
		const d = leans.reduce((acc, x) => acc + (margin(x.l, sw) > 0 ? x.seats : 0), 0);
		if (d >= need) return sw;
	}
	return null;
}

/** Parties with their seat counts, most seats first. */
export function rankParties(t: Tally, parties: Party[]): { p: Party; n: number }[] {
	return parties.map((p) => ({ p, n: t.seats[p.id] ?? 0 })).sort((a, b) => b.n - a.n);
}

/** "Democratic majority of 13" / "Hung: Republican largest, 4 short of a majority" */
export function majorityStatus(t: Tally, parties: Party[]): string {
	const [top, second] = rankParties(t, parties);
	if (!top || !top.n) return '';
	const need = Math.floor(t.total / 2) + 1;
	if (top.n >= need) return `${top.p.name} majority of ${top.n * 2 - t.total}`;
	if (second && top.n === second.n) return `Hung: ${top.p.name} and ${second.p.name} tied`;
	return `Hung: ${top.p.name} largest, ${need - top.n} short of a majority`;
}
