import { cellEffects, cellLabels, filterKey, matches, type Filter, type Segment } from './demographics';
import type { CellData, Party, Region } from './types';

/*
 * The vote model. Every region's electorate is split into demographic cells c (age x race x
 * edu x sex; a single "everyone" cell when an election has no demographic data). Every party
 * in the baseline election is modeled the same way.
 *
 * 1. Basis (fitted once per map + election): a multinomial logit. Party k's share of cell c in
 *    district d is
 *        P(k | c, d) = softmax_k(α_k,c + ρ_k,d)
 *    α_k is a NATIONAL matrix (how each cell votes for party k), ρ_k,d a per-district
 *    residual (how much more the district backs k than its demographics). One party is the
 *    reference (α = ρ = 0) only to pin down the scale; nothing else treats it differently.
 *    Fitted jointly so the real district results and the national per-cell totals are
 *    reproduced exactly (maximum likelihood with cell and district fixed effects per party).
 *
 * 2. Scenario (re-run on every change, one pass, nothing solved):
 *    a. Appeals: every party has an appeal in any voter group (single groups, intersections,
 *       Everyone), in points of its share of the group at the baseline. Each converts once to
 *       a fixed utility shift (see appealShift) and shifts add across every group a voter is
 *       in, so young men get Men + 18-29 + any young-men appeal. Districts follow through the
 *       logit, so +10 among young voters moves an R+40 district's young voters less.
 *    b. Turnout changes scale a group's voters (capped at 99.5% of citizens of voting age).
 *    c. The uniform D/R swing moves every district's two-party result by exactly that many
 *       points (shifting each cell in proportion to the voters it has left to give).
 *    d. Extra parties win voters away from each baseline party. A voter of party k in cell c
 *       stays or defects to party p with softmax odds exp(η_p,c + pull_p,k): η from its base
 *       share and its appeals, pull from how strongly it attracts k's voters ("pulls from").
 *    Every combination of inputs is valid; the outputs are the vote shares.
 * With no edits and no extra parties this reproduces the real results exactly.
 */

const LIM = 40;
const logit = (p: number) => {
	const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
	return Math.log(q / (1 - q));
};
/** log(p / q), the utility of share p against a reference share q */
const logRatio = (p: number, q: number) => clampLim(Math.log(Math.max(p, 1e-300) / Math.max(q, 1e-300)));
const clampLim = (x: number) => Math.max(-LIM, Math.min(LIM, x));
const sum = (a: ArrayLike<number>) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i];
	return s;
};

/** softmax of utilities u (in place into out) */
function softmax(u: ArrayLike<number>, out: Float64Array): Float64Array {
	let m = -Infinity;
	for (let k = 0; k < u.length; k++) m = Math.max(m, u[k]);
	let s = 0;
	for (let k = 0; k < u.length; k++) { out[k] = Math.exp(u[k] - m); s += out[k]; }
	for (let k = 0; k < u.length; k++) out[k] /= s;
	return out;
}

// ---------- 1. basis ----------

export interface RegionBasis {
	id: string;
	group: string;
	/** per cell: voters, citizen voting-age pop (null if unknown) */
	V: Float64Array;
	C: Float64Array | null;
	/** per baseline party (Basis.parties order), per cell: real votes */
	P: Float64Array[];
	/** per baseline party: district residual (log-odds vs the reference party, vote-weighted mean 0) */
	rho: Float64Array;
	/** per baseline party: real share, and the share if every cell voted at its national rate */
	actual: Record<string, number>;
	expected: Record<string, number>;
}

export interface Basis {
	n: number;
	labels: Record<string, string>[];
	/** the baseline election's parties; the last is the reference */
	parties: string[];
	/** per party, per cell: national utility (fitted jointly with the residuals) */
	alpha: Float64Array[];
	/** per party, per cell: national vote rate */
	rate: Float64Array[];
	/** per cell: national voters (weights for a group's baseline share) */
	voters: Float64Array;
	regions: Map<string, RegionBasis>;
}

/** Baseline parties of an election with demographic cells (older files: D, then R). */
export const cellParties = (cells?: CellData) => cells?.parties ?? ['D', 'R'];

/** Two-party D share of a per-party record. */
export const twoPartyD = (x: Record<string, number>) => (x.D + x.R > 0 ? x.D / (x.D + x.R) : 0);

export function fitBasis(regions: Region[], cells?: CellData): Basis {
	const labels = cells ? cellLabels(cells) : [{}];
	const n = labels.length;
	const parties = cellParties(cells);
	const K = parties.length;
	const ref = K - 1;
	const rated = regions.filter((r) => r.demShare !== null && r.votes > 0 && r.baseline);
	/** a region's real votes per party */
	const official = (r: Region) => parties.map((p) => r.baseline![p] ?? 0);

	// cell data: [cvap x n, voters x n, votes of parties[0..K-2] x n each]; the last party is
	// the rest. Regions without cell data borrow the national composition.
	const cellVotes = (r: Region) => {
		const c = r.cells!;
		const V = Float64Array.from(c.slice(n, 2 * n));
		const P = parties.map((_, k) => (k < ref ? Float64Array.from(c.slice((2 + k) * n, (3 + k) * n)) : new Float64Array(n)));
		for (let i = 0; i < n; i++) {
			let s = 0;
			for (let k = 0; k < ref; k++) s += P[k][i];
			P[ref][i] = Math.max(0, V[i] - s);
		}
		return { C: Float64Array.from(c.slice(0, n)), V, P };
	};
	const compV = new Float64Array(n);
	const compP = parties.map(() => new Float64Array(n));
	for (const r of rated) {
		if (!cells || !r.cells) continue;
		const { V, P } = cellVotes(r);
		for (let i = 0; i < n; i++) { compV[i] += V[i]; for (let k = 0; k < K; k++) compP[k][i] += P[k][i]; }
	}
	const compTot = sum(compV);

	const rows: RegionBasis[] = rated.map((r) => {
		const off = official(r);
		const tot = sum(off);
		const actual = Object.fromEntries(parties.map((p, k) => [p, off[k] / tot]));
		let V: Float64Array, P: Float64Array[], C: Float64Array | null = null;
		if (cells && r.cells) {
			({ C, V, P } = cellVotes(r));
		} else if (cells && compTot > 0) {
			V = compV.map((v) => (v / compTot) * tot);
			P = parties.map((_, k) => V.map((v, i) => (compV[i] ? (v * compP[k][i]) / compV[i] : 0)));
		} else {
			V = Float64Array.of(tot);
			P = off.map((x) => Float64Array.of(x));
		}
		return { id: r.id, group: r.group, V, C, P, rho: new Float64Array(K), actual, expected: { ...actual } };
	});

	const tot = rows.map((r) => sum(r.V));
	const Vc = new Float64Array(n);
	for (const r of rows) for (let i = 0; i < n; i++) Vc[i] += r.V[i];
	// national per-cell targets. The cell data's totals differ from the official results by
	// rounding (≤ ~50 votes a district): rescale each party's cell targets so both sets of
	// constraints can hold exactly. The reference party is the rest of each cell's voters.
	const T = parties.map((p, k) => {
		const t = new Float64Array(n);
		if (k === ref) return t;
		for (const r of rows) for (let i = 0; i < n; i++) t[i] += r.P[k][i];
		const want = rows.reduce((a, r, j) => a + r.actual[p] * tot[j], 0);
		const kT = want / (sum(t) || 1);
		return t.map((x) => x * kT);
	});
	for (let i = 0; i < n; i++) {
		let s = 0;
		for (let k = 0; k < ref; k++) s += T[k][i];
		T[ref][i] = Math.max(0, Vc[i] - s);
	}
	const rate = T.map((t) => Float64Array.from(t, (x, i) => (Vc[i] > 0 ? x / Vc[i] : 0)));
	const alpha = parties.map((_, k) => Float64Array.from(rate[k], (p, i) => logRatio(p, rate[ref][i])));

	const u = new Float64Array(K), pr = new Float64Array(K);
	const probs = (r: RegionBasis, i: number) => {
		for (let k = 0; k < K; k++) u[k] = alpha[k][i] + r.rho[k];
		return softmax(u, pr);
	};
	for (let sweep = 0; sweep < 1000 && K > 1; sweep++) {
		let worst = 0;
		// districts: Σ_c V P(k) = real votes of k
		rows.forEach((r, j) => {
			for (let k = 0; k < ref; k++) {
				const target = r.actual[parties[k]] * tot[j];
				for (let step = 0; step < 2; step++) {
					let f = -target, df = 0;
					for (let i = 0; i < n; i++) {
						if (!r.V[i]) continue;
						const p = probs(r, i)[k];
						f += r.V[i] * p;
						df += r.V[i] * p * (1 - p);
					}
					if (step === 0) worst = Math.max(worst, Math.abs(f) / tot[j]);
					if (df < 1e-12) break;
					r.rho[k] = clampLim(r.rho[k] - f / df);
				}
			}
		});
		// cells: Σ_d V P(k) = national votes of k in the cell
		for (let i = 0; i < n; i++) {
			if (!(Vc[i] > 0)) continue;
			for (let k = 0; k < ref; k++) {
				if (rate[k][i] <= 0 || rate[ref][i] <= 0) continue; // fixed at its boundary
				for (let step = 0; step < 2; step++) {
					let f = -T[k][i], df = 0;
					for (const r of rows) {
						if (!r.V[i]) continue;
						const p = probs(r, i)[k];
						f += r.V[i] * p;
						df += r.V[i] * p * (1 - p);
					}
					if (step === 0) worst = Math.max(worst, Math.abs(f) / Vc[i]);
					if (df < 1e-12) break;
					alpha[k][i] = clampLim(alpha[k][i] - f / df);
				}
			}
		}
		if (worst < 1e-10) break;
	}

	// α + c, ρ - c fit equally well: center each party's ρ (vote-weighted) so it reads "vs. the nation"
	const W = sum(tot);
	for (let k = 0; k < ref; k++) {
		const c = W ? rows.reduce((a, r, j) => a + r.rho[k] * tot[j], 0) / W : 0;
		for (const r of rows) r.rho[k] -= c;
		for (let i = 0; i < n; i++) alpha[k][i] += c;
	}
	rows.forEach((r, j) => {
		parties.forEach((p, k) => {
			let e = 0;
			for (let i = 0; i < n; i++) e += r.V[i] * rate[k][i];
			r.expected[p] = tot[j] ? e / tot[j] : r.actual[p];
		});
	});
	return { n, labels, parties, alpha, rate, voters: Vc, regions: new Map(rows.map((r) => [r.id, r])) };
}

/**
 * The demographics-only baseline: every cell votes at its national rate in every district
 * (no residual). National totals and each group's national share are unchanged; districts
 * differ only by who lives there.
 */
export function demographicsOnly(b: Basis): Basis {
	const ref = b.parties.length - 1;
	const alpha = b.rate.map((rk) => Float64Array.from(rk, (p, i) => logRatio(p, b.rate[ref][i])));
	const regions = new Map(
		[...b.regions].map(([id, r]) => [
			id,
			{
				...r,
				rho: new Float64Array(b.parties.length),
				actual: { ...r.expected },
				P: b.rate.map((rk) => r.V.map((v, i) => v * rk[i]))
			}
		])
	);
	return { ...b, alpha, regions };
}

/** District residual in D-vs-R margin points: real minus what its demographics predict (+ = more D). */
export function residualPoints(r: RegionBasis): number {
	return ((r.actual.D - r.expected.D) - (r.actual.R - r.expected.R)) * 100;
}

// ---------- 2. scenario ----------

export interface Scenario {
	/** uniform two-party swing in points (+ = toward D), the same in every district */
	swing: number;
	/** voter groups: turnout changes (and the custom groups' definitions) */
	segments: Segment[];
	parties: Party[];
}

export interface Simulation {
	/** baseline parties, then extra parties on the ballot */
	partyIds: string[];
	baselineParties: string[];
	/** per region: vote share by party id */
	shares: Map<string, Record<string, number>>;
	/** per region: two-party D share after appeals and turnout, before the uniform swing */
	lean: Map<string, number>;
	/** per region: number of voters */
	votes: Map<string, number>;
	/** national totals for the voters matching a filter */
	group(f: Filter): GroupResult;
}

export interface GroupResult {
	/** share of all voters */
	voterShare: number;
	turnout: number;
	/** vote share by party id, now */
	shares: Record<string, number>;
	/** the baseline election, per baseline party */
	before: { shares: Record<string, number>; turnout: number; voterShare: number };
}

const membership = (labels: Record<string, string>[], f: Filter) => Uint8Array.from(labels, (l) => (matches(l, f) ? 1 : 0));
const clampShare = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));

/** Extra parties that are on the ballot (some vote share somewhere). */
export const isLive = (p: Party) => p.core || p.share > 0 || p.appeals.some((a) => a.points > 0);

/** A baseline party's real national share of the voters matching a filter. */
export function baselineShare(b: Basis, partyId: string, f: Filter): number {
	const k = b.parties.indexOf(partyId);
	if (k < 0) return 0;
	const m = membership(b.labels, f);
	let v = 0, x = 0;
	for (let i = 0; i < b.n; i++) if (m[i]) { v += b.voters[i]; x += b.voters[i] * b.rate[k][i]; }
	return v ? x / v : 0;
}

/**
 * Appeals are entered in points of the party's share of the group, at the baseline: "+5"
 * = what would take it from s to s + 5 points if nothing else changed. Each converts ONCE
 * into a fixed utility shift, logit(s + x) - logit(s), with s from the real election (baseline
 * parties) or the party's own base share (new parties). Shifts add up across every group a
 * voter is in, so any combination of settings is valid and nothing has to be solved.
 */
export function appealShift(s: number, points: number): number {
	return logit(clampShare(s + points / 100)) - logit(clampShare(s));
}

export function simulate(b: Basis, regions: Region[], sc: Scenario): Simulation {
	const { n, labels, parties: base } = b;
	const K = base.length;
	const iD = base.indexOf('D'), iR = base.indexOf('R');
	const fx = cellEffects(labels, { segments: sc.segments });

	// baseline parties: utility shift per cell from their appeals
	const shift = base.map(() => new Float64Array(n));
	for (const p of sc.parties) {
		const k = base.indexOf(p.id);
		if (k < 0) continue;
		for (const a of p.appeals) {
			if (!a.points) continue;
			const d = appealShift(baselineShare(b, p.id, a.filter), a.points);
			const m = membership(labels, a.filter);
			for (let i = 0; i < n; i++) if (m[i]) shift[k][i] += d;
		}
	}

	// extra parties: a voter of baseline party k in cell c defects to p with odds
	//   exp(η_p,c + pull_p,k + stay_d), η_p,c = log(base share) + its appeals in c
	// stay_d = -log(1 - Σ base shares of the extra parties on the ballot in district d): with
	// neutral pulls and no appeals each party then wins exactly its base share in every district.
	const extras = sc.parties.filter((p) => !p.core && !base.includes(p.id) && isLive(p));
	const E = extras.length;
	const eta = extras.map((p) => {
		const x = p.share / 100;
		const e = new Float64Array(n).fill(x > 0 ? clampLim(Math.log(x)) : -LIM);
		for (const a of p.appeals) {
			if (!a.points) continue;
			const d = x > 0 ? appealShift(x, a.points) : logit(clampShare(a.points / 100)) + LIM;
			const m = membership(labels, a.filter);
			for (let i = 0; i < n; i++) if (m[i]) e[i] = clampLim(e[i] + d);
		}
		return e;
	});
	/** "pulls from": weight on D (fromD) vs R (the rest); 50/50 is neutral; other parties neutral */
	const pull = extras.map((p) =>
		base.map((id) => (id === 'D' ? Math.log(Math.max(1e-12, 2 * p.fromD / 100)) : id === 'R' ? Math.log(Math.max(1e-12, 2 * (1 - p.fromD / 100))) : 0))
	);
	const runs = extras.map((p) => (p.states.length ? new Set(p.states) : null));
	const partyIds = [...base, ...extras.map((p) => p.id)];

	const shares = new Map<string, Record<string, number>>();
	const lean = new Map<string, number>();
	const votesBy = new Map<string, number>();
	const cellParty: Record<string, Float64Array> = Object.fromEntries(partyIds.map((id) => [id, new Float64Array(n)]));
	const cellV = new Float64Array(n), cellC = new Float64Array(n);
	const baseV = new Float64Array(n), baseC = new Float64Array(n);
	const baseP = base.map(() => new Float64Array(n));
	const u = new Float64Array(K), S = base.map(() => new Float64Array(n)), pr = new Float64Array(K);
	const odds = new Float64Array(E);

	for (const r of regions) {
		const rb = b.regions.get(r.id);
		if (!rb) continue;
		const Vp = rb.V.map((v, i) => {
			const want = v * fx[i].mult;
			const cap = rb.C ? rb.C[i] * 0.995 : 0;
			return cap ? Math.min(want, cap) : want;
		});
		// baseline parties: softmax of national matrix + appeals + district residual
		let dv = 0, pool = 0;
		for (let i = 0; i < n; i++) {
			for (let k = 0; k < K; k++) u[k] = b.alpha[k][i] + shift[k][i] + rb.rho[k];
			softmax(u, pr);
			for (let k = 0; k < K; k++) S[k][i] = pr[k];
			if (iD >= 0 && iR >= 0) { dv += Vp[i] * pr[iD]; pool += Vp[i] * (pr[iD] + pr[iR]); }
		}
		// uniform swing: exactly swing/200 on the district's two-party D share, taken from
		// voters still available
		const L0 = pool ? dv / pool : twoPartyD(rb.actual);
		const L1 = Math.min(1, Math.max(0, L0 + sc.swing / 200));
		if (pool && L1 !== L0) {
			const up = L1 > L0;
			const kk = up ? (L1 - L0) / (1 - L0) : (L0 - L1) / L0;
			for (let i = 0; i < n; i++) {
				const p = S[iD][i] + S[iR][i];
				if (!p) continue;
				let l = S[iD][i] / p;
				l = up ? l + (1 - l) * kk : l * (1 - kk);
				S[iD][i] = p * l;
				S[iR][i] = p * (1 - l);
			}
		}
		// extra parties take their defectors from each baseline party
		const on = extras.flatMap((_, j) => (!runs[j] || runs[j]!.has(rb.group) ? [j] : []));
		const stay = -Math.log(Math.max(0.05, 1 - on.reduce((a, j) => a + extras[j].share / 100, 0)));
		const acc: Record<string, number> = Object.fromEntries(partyIds.map((id) => [id, 0]));
		let V = 0;
		for (let i = 0; i < n; i++) {
			baseV[i] += rb.V[i];
			for (let k = 0; k < K; k++) baseP[k][i] += rb.P[k][i];
			if (rb.C) { cellC[i] += rb.C[i]; baseC[i] += rb.C[i]; }
			if (!Vp[i]) continue;
			for (let k = 0; k < K; k++) {
				const L = Vp[i] * S[k][i];
				if (!L) continue;
				let s = 1;
				for (const j of on) { odds[j] = Math.exp(clampLim(eta[j][i] + pull[j][k] + stay)); s += odds[j]; }
				acc[base[k]] += L / s;
				cellParty[base[k]][i] += L / s;
				for (const j of on) {
					const v = (L * odds[j]) / s;
					acc[extras[j].id] += v;
					cellParty[extras[j].id][i] += v;
				}
			}
			V += Vp[i];
			cellV[i] += Vp[i];
		}
		if (V > 0) for (const id of partyIds) acc[id] /= V;
		shares.set(rb.id, acc);
		lean.set(rb.id, L0);
		votesBy.set(rb.id, V);
	}

	const allV = sum(cellV), allBase = sum(baseV);
	return {
		partyIds,
		baselineParties: base,
		shares,
		lean,
		votes: votesBy,
		group(f) {
			const m = membership(labels, f);
			let v = 0, c = 0, bv = 0, bc = 0;
			const s: Record<string, number> = Object.fromEntries(partyIds.map((id) => [id, 0]));
			const bs: Record<string, number> = Object.fromEntries(base.map((id) => [id, 0]));
			for (let i = 0; i < n; i++) {
				if (!m[i]) continue;
				v += cellV[i]; c += cellC[i]; bv += baseV[i]; bc += baseC[i];
				for (const id of partyIds) s[id] += cellParty[id][i];
				base.forEach((id, k) => { bs[id] += baseP[k][i]; });
			}
			for (const id of partyIds) s[id] = v > 0 ? s[id] / v : 0;
			for (const id of base) bs[id] = bv > 0 ? bs[id] / bv : 0;
			return {
				voterShare: allV ? v / allV : 0,
				turnout: c ? v / c : 0,
				shares: s,
				before: { shares: bs, turnout: bc ? bv / bc : 0, voterShare: allBase ? bv / allBase : 0 }
			};
		}
	};
}

/**
 * "Fit to…": the appeal (points) that gives `partyId` a national share of `target` (0..1)
 * among the voters matching `filter`, with every other setting as it is. Solved once by
 * bisection (share rises with appeal); `reached` is false when the target is out of range.
 */
export function fitAppeal(
	b: Basis, regions: Region[], sc: Scenario, partyId: string, filter: Filter, target: number
): { points: number; reached: boolean } {
	const key = filterKey(filter);
	const party = sc.parties.find((p) => p.id === partyId);
	if (!party) return { points: 0, reached: false };
	const at = (points: number) => {
		const appeals = [...party.appeals.filter((a) => filterKey(a.filter) !== key), { filter, points }];
		const parties = sc.parties.map((p) => (p.id === partyId ? { ...p, appeals } : p));
		return simulate(b, regions, { ...sc, parties }).group(filter).shares[partyId] ?? 0;
	};
	let lo = -100, hi = 100;
	const fLo = at(lo), fHi = at(hi);
	if (target <= fLo) return { points: lo, reached: Math.abs(fLo - target) < 0.005 };
	if (target >= fHi) return { points: hi, reached: Math.abs(fHi - target) < 0.005 };
	for (let it = 0; it < 30 && hi - lo > 0.05; it++) {
		const mid = (lo + hi) / 2;
		if (at(mid) < target) lo = mid;
		else hi = mid;
	}
	return { points: Math.round(((lo + hi) / 2) * 10) / 10, reached: true };
}
