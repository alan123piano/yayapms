import { RATING_THRESHOLDS as T } from './config';
import { simulate, type Basis, type Scenario, type Simulation } from './model';
import type { Level, Outcome, Override, Party, Region } from './types';

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
	/** total seats per party (districts + list seats under MMP) */
	seats: Record<string, number>;
	unrated: number;
	total: number;
	/** MMP only: the breakdown of `seats` */
	mmp?: {
		districts: Record<string, number>;
		list: Record<string, number>;
		/** national list vote share per party (0..1) */
		vote: Record<string, number>;
		/** parties that cleared the threshold (or won enough districts) */
		eligible: string[];
		/** seats beyond the base house size (overhang kept, or levelling seats) */
		extra: number;
	};
}

/**
 * How seats are assigned.
 *   fptp: each district goes to whoever gets the most votes.
 *   mmp:  mixed-member proportional (German / New Zealand style). Districts are won by FPTP,
 *         then list seats top every party up to its proportional share of the whole house,
 *         by national vote, with the Sainte-Laguë method. Only parties over `threshold`% of
 *         the national vote, or winning at least `waiver` districts (0 = no waiver), share
 *         the list seats. When a party wins more districts than its share ("overhang"), it
 *         keeps them; `overhang: 'level'` then grows the house until every eligible party is
 *         proportional again (Germany 2013-2023), 'keep' does not (New Zealand).
 */
export type SeatSystem =
	| { kind: 'fptp' }
	| { kind: 'mmp'; listSeats: number; threshold: number; waiver: number; overhang: 'keep' | 'level' };

export const FPTP: SeatSystem = { kind: 'fptp' };

function districtTally(regions: Region[], ctx: SimContext): Tally {
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

/** Sainte-Laguë: `seats` seats among parties by votes (highest averages v / (2s + 1)). */
export function sainteLague(votes: Record<string, number>, seats: number): Record<string, number> {
	const out: Record<string, number> = Object.fromEntries(Object.keys(votes).map((id) => [id, 0]));
	const ids = Object.keys(votes).filter((id) => votes[id] > 0);
	for (let k = 0; k < seats && ids.length; k++) {
		let best = ids[0];
		for (const id of ids) if (votes[id] / (2 * out[id] + 1) > votes[best] / (2 * out[best] + 1)) best = id;
		out[best]++;
	}
	return out;
}

export function tally(regions: Region[], ctx: SimContext, system: SeatSystem = FPTP): Tally {
	const t = districtTally(regions, ctx);
	if (system.kind === 'fptp') return t;

	// national list vote: simulated votes over the regions in scope
	const raw: Record<string, number> = Object.fromEntries(ctx.parties.map((p) => [p.id, 0]));
	let all = 0;
	for (const r of regions) {
		const sh = ctx.sim?.shares.get(r.id);
		const v = ctx.sim?.votes.get(r.id) ?? 0;
		if (!sh) continue;
		for (const [id, x] of Object.entries(sh)) if (id in raw) raw[id] += v * x;
		all += v;
	}
	const vote = Object.fromEntries(Object.entries(raw).map(([id, v]) => [id, all ? v / all : 0]));
	const districts = { ...t.seats };
	const eligible = ctx.parties
		.map((p) => p.id)
		.filter((id) => vote[id] * 100 >= system.threshold || (system.waiver > 0 && districts[id] >= system.waiver));
	const pool = Object.fromEntries(eligible.map((id) => [id, raw[id]]));

	// base house: the districts with a result plus the list seats; districts won by ineligible
	// parties stay theirs and are taken off the proportional pool
	const rated = t.total - t.unrated;
	const base = rated + Math.round((rated * system.listSeats) / 100);
	const outside = ctx.parties.filter((p) => !eligible.includes(p.id)).reduce((a, p) => a + districts[p.id], 0);
	let house = Math.max(0, base - outside);
	let ent = sainteLague(pool, house);
	if (system.overhang === 'level') {
		// grow the proportional pool until no eligible party has more districts than its share
		while (eligible.some((id) => districts[id] > ent[id]) && house < base * 4) ent = sainteLague(pool, ++house);
	}
	const list: Record<string, number> = Object.fromEntries(ctx.parties.map((p) => [p.id, 0]));
	for (const id of eligible) list[id] = Math.max(0, ent[id] - districts[id]);
	const seats = Object.fromEntries(ctx.parties.map((p) => [p.id, districts[p.id] + list[p.id]]));
	const total = Object.values(seats).reduce((a, b) => a + b, 0) + t.unrated;
	return {
		seats,
		unrated: t.unrated,
		total,
		mmp: { districts, list, vote, eligible, extra: total - t.unrated - base }
	};
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
