import { cellEffects, cellLabels, matches, type Filter, type Segment } from './demographics';
import type { CellData, Party, Region } from './types';

/*
 * The vote model. Every region's electorate is split into demographic cells c (age x race x
 * edu x sex; a single "everyone" cell when an election has no demographic data).
 *
 * 1. Basis (fitted once per map + election): the D-vs-R lean of cell c in district d is
 *        P(D | c, d) = σ(α_c + ρ_d)
 *    α_c is a NATIONAL matrix (how each cell votes), ρ_d a per-district residual (how much
 *    more D or R the district is than its demographics). Both are fitted together so the real
 *    district results and the national per-cell totals are reproduced exactly: this is the
 *    maximum-likelihood fit of a logit with cell and district fixed effects.
 *
 * 2. Scenario (re-run on every change):
 *    a. Voter-group edits move the national matrix: vote swings shift a cell's national D
 *       share (points), turnout changes scale its voters. Districts follow through the logit,
 *       so a +10 swing among young voters moves an R+40 district's young voters less.
 *    b. Core-party appeals ("D wins 70% of Hispanics") add a logit shift to the cells of that
 *       group, solved so the national result hits the target.
 *    c. The uniform D/R swing moves every district's two-party result by exactly that many
 *       points (shifting each cell in proportion to the voters it has left to give).
 *    d. Extra parties win voters away from each side. A D-side voter in cell c stays with D
 *       or defects to party p with softmax odds exp(η_pD,c), where
 *           η_p,side,c = base_p + Σ appeals_p,g [c in g] ± tilt_p
 *       base_p sets its share among voters outside its target groups, each appeal its share
 *       within a group, tilt_p how many of its voters come from D vs R. All are solved
 *       jointly against national (where-it-runs) totals.
 * With no edits and no extra parties this reproduces the real results exactly.
 */

const LIM = 40;
const sig = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => {
	const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
	return Math.log(q / (1 - q));
};
const clampLim = (x: number) => Math.max(-LIM, Math.min(LIM, x));
const sum = (a: ArrayLike<number>) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i];
	return s;
};

// ---------- 1. basis ----------

export interface RegionBasis {
	id: string;
	group: string;
	/** per cell: voters, real Dem votes, citizen voting-age pop (null if unknown) */
	V: Float64Array;
	D: Float64Array;
	C: Float64Array | null;
	/** district residual (logit units, vote-weighted mean 0 across the map) */
	rho: number;
	/** real two-party D share */
	actual: number;
	/** D share its demographics alone predict (ρ = 0) */
	expected: number;
}

export interface Basis {
	n: number;
	labels: Record<string, string>[];
	/** national D-vs-R logit per cell */
	alpha: Float64Array;
	regions: Map<string, RegionBasis>;
}

export function fitBasis(regions: Region[], cells?: CellData): Basis {
	const labels = cells ? cellLabels(cells) : [{}];
	const n = labels.length;
	const rated = regions.filter((r) => r.demShare !== null && r.votes > 0);

	// regions without cell data borrow the national composition
	const compV = new Float64Array(n), compD = new Float64Array(n);
	for (const r of rated) {
		if (!cells || !r.cells) continue;
		for (let i = 0; i < n; i++) { compV[i] += r.cells[n + i]; compD[i] += r.cells[2 * n + i]; }
	}
	const compTot = sum(compV);

	const rows: RegionBasis[] = rated.map((r) => {
		let V: Float64Array, D: Float64Array, C: Float64Array | null = null;
		if (cells && r.cells) {
			C = Float64Array.from(r.cells.slice(0, n));
			V = Float64Array.from(r.cells.slice(n, 2 * n));
			D = Float64Array.from(r.cells.slice(2 * n, 3 * n));
		} else if (cells && compTot > 0) {
			V = compV.map((v) => (v / compTot) * r.votes);
			const exp = sum(V.map((v, i) => (compV[i] ? (v * compD[i]) / compV[i] : 0)));
			const k = exp > 0 ? (r.demShare! * r.votes) / exp : 0;
			D = V.map((v, i) => (compV[i] ? Math.min(v, (k * v * compD[i]) / compV[i]) : 0));
		} else {
			V = Float64Array.of(r.votes);
			D = Float64Array.of(r.demShare! * r.votes);
		}
		return { id: r.id, group: r.group, V, D, C, rho: 0, actual: r.demShare!, expected: r.demShare! };
	});

	const alpha = new Float64Array(n);
	const T = new Float64Array(n), Vc = new Float64Array(n);
	for (const r of rows) for (let i = 0; i < n; i++) { T[i] += r.D[i]; Vc[i] += r.V[i]; }
	const tot = rows.map((r) => sum(r.V));
	// the cell data's Dem total differs from the official results by rounding (≤ ~50 votes a
	// district): rescale the cell targets so both sets of constraints can hold exactly
	const kT = rows.reduce((a, r, j) => a + r.actual * tot[j], 0) / (sum(T) || 1);
	for (let i = 0; i < n; i++) T[i] = Math.min(Vc[i], T[i] * kT);
	for (let i = 0; i < n; i++) alpha[i] = Vc[i] > 0 ? logit(T[i] / Vc[i]) : 0;

	for (let sweep = 0; sweep < 1000; sweep++) {
		// districts: Σ_c V σ(α + ρ) = actual · ΣV
		let worst = 0;
		rows.forEach((r, k) => {
			const target = r.actual * tot[k];
			for (let step = 0; step < 2; step++) {
				let f = -target, df = 0;
				for (let i = 0; i < n; i++) {
					if (!r.V[i]) continue;
					const p = sig(alpha[i] + r.rho);
					f += r.V[i] * p;
					df += r.V[i] * p * (1 - p);
				}
				if (step === 0) worst = Math.max(worst, Math.abs(f) / tot[k]);
				if (df < 1e-12) break;
				r.rho = clampLim(r.rho - f / df);
			}
		});
		// cells: Σ_d V σ(α + ρ) = national Dem votes in the cell
		let worstCell = 0;
		for (let i = 0; i < n; i++) {
			if (!(Vc[i] > 0) || T[i] <= 0 || T[i] >= Vc[i]) {
				alpha[i] = Vc[i] > 0 ? (T[i] <= 0 ? -LIM : T[i] >= Vc[i] ? LIM : 0) : 0;
				continue;
			}
			for (let step = 0; step < 2; step++) {
				let f = -T[i], df = 0;
				for (const r of rows) {
					if (!r.V[i]) continue;
					const p = sig(alpha[i] + r.rho);
					f += r.V[i] * p;
					df += r.V[i] * p * (1 - p);
				}
				if (step === 0) worstCell = Math.max(worstCell, Math.abs(f) / Vc[i]);
				if (df < 1e-12) break;
				alpha[i] = clampLim(alpha[i] - f / df);
			}
		}
		if (worst < 1e-10 && worstCell < 1e-10) break;
	}

	// α + k, ρ - k fit equally well: center ρ (vote-weighted) so it reads as "vs. the nation"
	const W = sum(tot);
	const k = W ? rows.reduce((a, r, j) => a + r.rho * tot[j], 0) / W : 0;
	for (const r of rows) r.rho -= k;
	for (let i = 0; i < n; i++) alpha[i] += k;
	rows.forEach((r, j) => {
		let e = 0;
		for (let i = 0; i < n; i++) e += r.V[i] * sig(alpha[i]);
		r.expected = tot[j] ? e / tot[j] : r.actual;
	});
	return { n, labels, alpha, regions: new Map(rows.map((r) => [r.id, r])) };
}

/** District residual in margin points: real result minus what its demographics predict (+ = more D). */
export function residualPoints(r: RegionBasis): number {
	return (r.actual - r.expected) * 200;
}

// ---------- 2. scenario ----------

export interface Scenario {
	/** uniform two-party swing in points (+ = toward D) */
	swing: number;
	segments: Segment[];
	parties: Party[];
}

export interface Simulation {
	partyIds: string[];
	/** per region: vote share by party id */
	shares: Map<string, Record<string, number>>;
	/** per region: two-party D share after voter-group edits and core appeals, before the uniform swing */
	lean: Map<string, number>;
	/** per region: number of voters */
	votes: Map<string, number>;
	/** whether every target was reached */
	converged: boolean;
	/** national totals for the voters matching a filter */
	group(f: Filter): GroupResult;
}

export interface GroupResult {
	/** share of all voters */
	voterShare: number;
	turnout: number;
	/** vote share by party id */
	shares: Record<string, number>;
	/** real election: two-party D share and turnout */
	before: { dem: number; turnout: number; voterShare: number };
}

interface Target { m: Uint8Array; t: number; x: number }
interface Extra {
	id: string;
	bit: number;
	runs: Set<string> | null;
	/** share among voters outside every target group (null: no base level) */
	out: number | null;
	outside: Uint8Array;
	appeals: Target[];
	fromD: number;
	base: number;
	tilt: number;
}

const membership = (labels: Record<string, string>[], f: Filter) => Uint8Array.from(labels, (l) => (matches(l, f) ? 1 : 0));

/** Extra parties that are on the ballot (some vote share somewhere). */
export const isLive = (p: Party) => p.core || p.share > 0 || p.appeals.some((a) => a.share > 0);

export function simulate(b: Basis, regions: Region[], sc: Scenario): Simulation {
	const { n, labels } = b;
	const fx = cellEffects(labels, { segments: sc.segments });
	// a. voter-group vote swings move the national matrix
	const a0 = Float64Array.from(b.alpha, (a, i) => (fx[i].shift ? logit(sig(a) + fx[i].shift) : a));

	// b. core appeals: one logit shift per (party, group), + toward D
	const core: (Target & { id: string; sign: number })[] = sc.parties
		.filter((p) => p.core)
		.flatMap((p) =>
			p.appeals.map((a) => ({ id: p.id, sign: p.id === 'R' ? -1 : 1, m: membership(labels, a.filter), t: a.share / 100, x: 0 }))
		);
	// d. extra parties
	const extras: Extra[] = sc.parties
		.filter((p) => !p.core && isLive(p))
		.map((p, j) => {
			const appeals = p.appeals.map((a) => ({ m: membership(labels, a.filter), t: a.share / 100, x: 0 }));
			const outside = Uint8Array.from(labels, (_, i) => (appeals.some((a) => a.m[i]) ? 0 : 1));
			const out = p.share > 0 ? p.share / 100 : appeals.length ? null : 0;
			const base = out ? logit(out) : -LIM;
			for (const a of appeals) a.x = logit(Math.max(a.t, 1e-6)) - base;
			return { id: p.id, bit: 1 << j, runs: p.states.length ? new Set(p.states) : null, out, outside, appeals, fromD: p.fromD / 100, base, tilt: 0 };
		});
	const partyIds = [...sc.parties.filter((p) => p.core).map((p) => p.id), ...extras.map((e) => e.id)];

	interface Row { rb: RegionBasis; Vp: Float64Array; lean: Float64Array; L0: number; mask: number }
	const rows: Row[] = [];
	for (const r of regions) {
		const rb = b.regions.get(r.id);
		if (!rb) continue;
		const Vp = rb.V.map((v, i) => {
			const want = v * fx[i].mult;
			const cap = rb.C ? rb.C[i] * 0.995 : 0;
			return cap ? Math.min(want, cap) : want;
		});
		let mask = 0;
		for (const e of extras) if (!e.runs || e.runs.has(rb.group)) mask |= e.bit;
		rows.push({ rb, Vp, lean: new Float64Array(n), L0: rb.actual, mask });
	}

	// per signature (set of extras on the ballot): D-side / R-side / all voters per cell
	type Agg = { mask: number; on: Extra[]; Ld: Float64Array; Lr: Float64Array; V: Float64Array };
	const aggs = new Map<number, Agg>();
	for (const row of rows) {
		if (!aggs.has(row.mask)) {
			aggs.set(row.mask, { mask: row.mask, on: extras.filter((e) => row.mask & e.bit), Ld: new Float64Array(n), Lr: new Float64Array(n), V: new Float64Array(n) });
		}
	}

	function computeLean() {
		for (const a of aggs.values()) { a.Ld.fill(0); a.Lr.fill(0); a.V.fill(0); }
		const shiftK = new Float64Array(n);
		for (const t of core) for (let i = 0; i < n; i++) if (t.m[i]) shiftK[i] += t.sign * t.x;
		for (const row of rows) {
			const { Vp, lean, rb } = row;
			let V = 0, L = 0;
			for (let i = 0; i < n; i++) {
				lean[i] = sig(a0[i] + shiftK[i] + rb.rho);
				V += Vp[i];
				L += Vp[i] * lean[i];
			}
			row.L0 = V ? L / V : rb.actual;
			// c. uniform swing: exactly swing/200 on the district, taken from voters still available
			const L1 = Math.min(1, Math.max(0, row.L0 + sc.swing / 200));
			if (L1 > row.L0 && row.L0 < 1) {
				const k = (L1 - row.L0) / (1 - row.L0);
				for (let i = 0; i < n; i++) lean[i] += (1 - lean[i]) * k;
			} else if (L1 < row.L0 && row.L0 > 0) {
				const k = (row.L0 - L1) / row.L0;
				for (let i = 0; i < n; i++) lean[i] *= 1 - k;
			}
			const a = aggs.get(row.mask)!;
			for (let i = 0; i < n; i++) {
				a.Ld[i] += Vp[i] * lean[i];
				a.Lr[i] += Vp[i] * (1 - lean[i]);
				a.V[i] += Vp[i];
			}
		}
	}

	/** η of extra e in cell i, before the ± tilt */
	const eta = (e: Extra, i: number) => {
		let x = e.base;
		for (const a of e.appeals) if (a.m[i]) x += a.x;
		return x;
	};

	/** national votes per cell: core parties, then each extra (+ its D-side part and where-it-runs voters) */
	function totals() {
		const votes: Record<string, Float64Array> = {};
		const fromD: Record<string, Float64Array> = {};
		const runV: Record<string, Float64Array> = {};
		for (const id of partyIds) { votes[id] = new Float64Array(n); fromD[id] = new Float64Array(n); runV[id] = new Float64Array(n); }
		const allV = new Float64Array(n);
		for (const a of aggs.values()) {
			for (let i = 0; i < n; i++) {
				let sD = 1, sR = 1;
				const eD: number[] = [], eR: number[] = [];
				for (const e of a.on) {
					const x = eta(e, i);
					const d = Math.exp(clampLim(x + e.tilt)), r = Math.exp(clampLim(x - e.tilt));
					eD.push(d); eR.push(r); sD += d; sR += r;
				}
				votes.D[i] += a.Ld[i] / sD;
				votes.R[i] += a.Lr[i] / sR;
				allV[i] += a.V[i];
				a.on.forEach((e, k) => {
					const fd = (a.Ld[i] * eD[k]) / sD;
					votes[e.id][i] += fd + (a.Lr[i] * eR[k]) / sR;
					fromD[e.id][i] += fd;
					runV[e.id][i] += a.V[i];
				});
			}
		}
		return { votes, fromD, runV, allV };
	}

	const shareIn = (num: Float64Array, den: Float64Array, m: Uint8Array) => {
		let a = 0, d = 0;
		for (let i = 0; i < n; i++) if (m[i]) { a += num[i]; d += den[i]; }
		return d > 0 ? a / d : NaN;
	};

	// Targets can be unreachable (e.g. D at 75% of a group while other parties take most of
	// it); the loops then stop once they stall and the result is the closest they got.
	let converged = true;
	const outer = core.length ? 40 : 1;
	let prevOuter = Infinity;
	for (let o = 0; o < outer; o++) {
		computeLean();
		let prevInner = Infinity;
		for (let it = 0; it < 200 && extras.length; it++) {
			let worst = 0;
			for (const e of extras) {
				const step = (cur: number, t: number) => {
					if (!Number.isFinite(cur)) return 0;
					worst = Math.max(worst, Math.abs(cur - t));
					return logit(t) - logit(cur);
				};
				let T = totals();
				if (e.out !== null) e.base = clampLim(e.base + step(shareIn(T.votes[e.id], T.runV[e.id], e.outside), e.out));
				for (const a of e.appeals) {
					T = totals();
					a.x = clampLim(a.x + step(shareIn(T.votes[e.id], T.runV[e.id], a.m), a.t));
				}
				T = totals();
				const got = sum(T.votes[e.id]);
				if (got > 0 && e.fromD > 0 && e.fromD < 1) {
					const cur = sum(T.fromD[e.id]) / got;
					worst = Math.max(worst, Math.abs(cur - e.fromD));
					e.tilt = clampLim(e.tilt + 0.5 * (logit(e.fromD) - logit(cur)));
				} else if (e.fromD <= 0 || e.fromD >= 1) {
					e.tilt = e.fromD >= 1 ? LIM / 2 : -LIM / 2;
				}
			}
			if (worst < 1e-7) break;
			if (worst > prevInner * 0.999 || it === 199) { converged = false; break; }
			prevInner = worst;
		}
		if (!core.length) break;
		const T = totals();
		let worst = 0;
		for (const t of core) {
			const cur = shareIn(T.votes[t.id], T.allV, t.m);
			if (!Number.isFinite(cur)) continue;
			worst = Math.max(worst, Math.abs(cur - t.t));
			t.x = clampLim(t.x + t.sign * (logit(t.t) - logit(cur)));
		}
		if (worst < 1e-6) break;
		if (worst > prevOuter * 0.98 || o === outer - 1) { converged = false; break; }
		prevOuter = worst;
	}

	// final pass: per-region shares, national per-cell totals
	const shares = new Map<string, Record<string, number>>();
	const lean = new Map<string, number>();
	const votesBy = new Map<string, number>();
	const cellParty: Record<string, Float64Array> = Object.fromEntries(partyIds.map((id) => [id, new Float64Array(n)]));
	const cellV = new Float64Array(n), cellC = new Float64Array(n);
	const baseV = new Float64Array(n), baseD = new Float64Array(n), baseC = new Float64Array(n);
	const eD = new Float64Array(extras.length), eR = new Float64Array(extras.length);
	for (const row of rows) {
		const { Vp, lean: ln, rb, mask } = row;
		const acc: Record<string, number> = Object.fromEntries(partyIds.map((id) => [id, 0]));
		let V = 0;
		for (let i = 0; i < n; i++) {
			if (!Vp[i]) continue;
			let sD = 1, sR = 1;
			extras.forEach((e, k) => {
				if (!(mask & e.bit)) { eD[k] = eR[k] = 0; return; }
				const x = eta(e, i);
				eD[k] = Math.exp(clampLim(x + e.tilt));
				eR[k] = Math.exp(clampLim(x - e.tilt));
				sD += eD[k]; sR += eR[k];
			});
			const d = Vp[i] * ln[i], r = Vp[i] * (1 - ln[i]);
			const add = (id: string, v: number) => { acc[id] += v; cellParty[id][i] += v; };
			add('D', d / sD);
			add('R', r / sR);
			extras.forEach((e, k) => { if (mask & e.bit) add(e.id, (d * eD[k]) / sD + (r * eR[k]) / sR); });
			V += Vp[i];
			cellV[i] += Vp[i];
			baseV[i] += rb.V[i];
			baseD[i] += rb.D[i];
			if (rb.C) { cellC[i] += rb.C[i]; baseC[i] += rb.C[i]; }
		}
		if (V > 0) for (const id of partyIds) acc[id] /= V;
		shares.set(rb.id, acc);
		lean.set(rb.id, row.L0);
		votesBy.set(rb.id, V);
	}

	const allV = sum(cellV), allBase = sum(baseV);
	return {
		partyIds,
		shares,
		lean,
		votes: votesBy,
		converged,
		group(f) {
			const m = membership(labels, f);
			let v = 0, c = 0, bv = 0, bd = 0, bc = 0;
			const s: Record<string, number> = Object.fromEntries(partyIds.map((id) => [id, 0]));
			for (let i = 0; i < n; i++) {
				if (!m[i]) continue;
				v += cellV[i]; c += cellC[i]; bv += baseV[i]; bd += baseD[i]; bc += baseC[i];
				for (const id of partyIds) s[id] += cellParty[id][i];
			}
			if (v > 0) for (const id of partyIds) s[id] /= v;
			return {
				voterShare: allV ? v / allV : 0,
				turnout: c ? v / c : 0,
				shares: s,
				before: { dem: bv ? bd / bv : 0, turnout: bc ? bv / bc : 0, voterShare: allBase ? bv / allBase : 0 }
			};
		}
	};
}
