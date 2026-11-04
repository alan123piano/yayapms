import type { Level, Outcome, Override, Party, Region } from './types';

/** Margin thresholds (points, winner minus runner-up) for Tilt / Lean / Likely / Safe. */
export const THRESHOLDS = [3, 8, 15] as const;

/** Two-party Dem margin in points after a uniform swing (swing in points, + = toward D). */
export function margin(demShare: number, swing: number): number {
	return (2 * demShare - 1) * 100 + swing;
}

export function levelFromMargin(m: number): Level {
	const a = Math.abs(m);
	return a < THRESHOLDS[0] ? 1 : a < THRESHOLDS[1] ? 2 : a < THRESHOLDS[2] ? 3 : 4;
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
	for (const p of parties) {
		if (p.core || !(p.share > 0)) continue;
		const groups = p.states.length ? new Set(p.states) : null;
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
	return { swing, parties, overrides, defections };
}

export function shares(r: Region, ctx: SimContext): Record<string, number> | null {
	if (r.demShare === null) return null;
	const d = swungDem(r, ctx.swing);
	const rep = 1 - d;
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

/** Two-party only: smallest uniform swing (0.1 pt) giving D a majority, or null within ±30. */
export function tippingSwing(regions: Region[]): number | null {
	const rated = regions.filter((r) => r.demShare !== null);
	const total = rated.reduce((s, r) => s + r.seats, 0);
	if (!total) return null;
	const need = Math.floor(total / 2) + 1;
	for (let s = -300; s <= 300; s++) {
		const sw = s / 10;
		const d = rated.reduce((acc, r) => acc + (margin(r.demShare!, sw) > 0 ? r.seats : 0), 0);
		if (d >= need) return sw;
	}
	return null;
}
