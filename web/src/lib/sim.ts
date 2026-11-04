import { RATING_THRESHOLDS as T } from './config';
import { filterKey } from './demographics';
import type { Level, Outcome, Override, Party, Region } from './types';

/** Two-party Dem margin in points after a uniform swing (swing in points, + = toward D). */
export function margin(demShare: number, swing: number): number {
	return (2 * demShare - 1) * 100 + swing;
}

export function levelFromMargin(m: number): Level {
	const a = Math.abs(m);
	return a < T[0] ? 1 : a < T[1] ? 2 : a < T[2] ? 3 : 4;
}

/**
 * Multiparty model (UK-style "proportional swing"):
 *   1. Apply the uniform two-party swing to each region's D/R baseline.
 *   2. Each extra party wins over a fixed FRACTION of D voters and of R voters, the same
 *      everywhere it runs, chosen so its average share where it runs equals its target.
 *      A party drawing mostly from D is therefore strongest where D is strongest.
 *   3. Plurality (first-past-the-post) winner per region.
 * With no extra parties this reduces exactly to the two-party model.
 */
interface Defection {
	id: string;
	fD: number;
	fR: number;
	groups: Set<string> | null;
}

export interface SimContext {
	swing: number;
	parties: Party[];
	overrides: Record<string, Override>;
	defections: Defection[];
	/** parties appealing to one voter group: they win `share` of that group's voters */
	targeted: { id: string; key: string; share: number; fromD: number; groups: Set<string> | null }[];
}

function swungDem(r: Region, swing: number): number {
	return Math.min(1, Math.max(0, r.demShare! + swing / 200));
}

export function buildContext(
	regions: Region[],
	parties: Party[],
	swing: number,
	overrides: Record<string, Override>
): SimContext {
	const defections: Defection[] = [];
	const targeted: SimContext['targeted'] = [];
	for (const p of parties) {
		if (p.core || !(p.share > 0)) continue;
		const groups = p.states.length ? new Set(p.states) : null;
		if (p.audience) {
			targeted.push({ id: p.id, key: filterKey(p.audience), share: p.share / 100, fromD: p.fromD / 100, groups });
			continue;
		}
		let v = 0, dv = 0;
		for (const r of regions) {
			if (r.demShare === null || !r.votes || (groups && !groups.has(r.group))) continue;
			v += r.votes;
			dv += r.votes * swungDem(r, swing);
		}
		if (!v) continue;
		const dBar = dv / v;
		const s = p.share / 100;
		const fromD = p.fromD / 100;
		defections.push({
			id: p.id,
			fD: dBar > 0 ? (s * fromD) / dBar : 0,
			fR: dBar < 1 ? (s * (1 - fromD)) / (1 - dBar) : 0,
			groups
		});
	}
	return { swing, parties, overrides, defections, targeted };
}

export function shares(r: Region, ctx: SimContext): Record<string, number> | null {
	if (r.demShare === null) return null;
	let d = swungDem(r, ctx.swing);
	let rep = 1 - d;
	// Group-targeted parties first: each wins `share` of its group's voters here. fromD is a
	// preference for where they come from; if one side runs short, the rest comes from the other.
	const taken: Record<string, number> = {};
	for (const t of ctx.targeted) {
		const a = r.audiences?.[t.key];
		if (!a || (t.groups && !t.groups.has(r.group))) continue;
		const gD = a.share * Math.min(1, Math.max(0, a.dem + ctx.swing / 200));
		const gR = a.share - gD;
		const want = t.share * a.share;
		let fromD = Math.min(want * t.fromD, gD, d);
		const fromR = Math.min(want - fromD, gR, rep);
		fromD = Math.min(want - fromR, gD, d);
		d -= fromD;
		rep -= fromR;
		taken[t.id] = (taken[t.id] ?? 0) + fromD + fromR;
	}
	const here = ctx.defections.filter((x) => !x.groups || x.groups.has(r.group));
	// If targets are so large that more than all of a party's voters would leave, scale down.
	const sD = here.reduce((a, x) => a + x.fD, 0);
	const sR = here.reduce((a, x) => a + x.fR, 0);
	const kD = sD > 1 ? 1 / sD : 1;
	const kR = sR > 1 ? 1 / sR : 1;
	const out: Record<string, number> = {
		D: d * (1 - sD * kD),
		R: rep * (1 - sR * kR)
	};
	for (const x of here) out[x.id] = d * x.fD * kD + rep * x.fR * kR;
	for (const [id, v] of Object.entries(taken)) out[id] = (out[id] ?? 0) + v;
	return out;
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
export function tippingSwing(regions: Region[]): number | null {
	const rated = regions.filter((r) => r.demShare !== null);
	const total = rated.reduce((s, r) => s + r.seats, 0);
	if (!total) return null;
	const need = Math.floor(total / 2) + 1;
	for (let s = -400; s <= 400; s++) {
		const sw = s / 10;
		const d = rated.reduce((acc, r) => acc + (margin(r.demShare!, sw) > 0 ? r.seats : 0), 0);
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
