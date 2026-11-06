import { cellEffects, cellLabels, matches, type Filter, type Segment } from './demographics';
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
 * 2. Scenario (re-run on every change):
 *    a. Voter-group edits move the national matrix: vote swings shift a cell's D-vs-R split
 *       (points), turnout changes scale its voters. Districts follow through the logit, so a
 *       +10 swing among young voters moves an R+40 district's young voters less.
 *    b. Appeals by baseline parties ("D wins 70% of Hispanics", "R wins 60% of men") add to
 *       that party's utility in the group's cells, solved so the national result hits target.
 *    c. The uniform D/R swing moves every district's two-party result by exactly that many
 *       points (shifting each cell in proportion to the voters it has left to give).
 *    d. Extra parties win voters away from each baseline party. A voter of party k in cell c
 *       stays or defects to party p with softmax odds exp(η_p,k,c), where
 *           η_p,k,c = base_p + Σ appeals_p,g [c in g] + tilt_p · (+1 for D, −1 for R, else 0)
 *       base_p sets its share among voters outside its target groups, each appeal its share
 *       within a group, tilt_p how many of its voters come from D vs R. All are solved
 *       jointly against national (where-it-runs) totals.
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
	return { n, labels, parties, alpha, rate, regions: new Map(rows.map((r) => [r.id, r])) };
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
	/** uniform two-party swing in points (+ = toward D) */
	swing: number;
	segments: Segment[];
	parties: Party[];
}

export interface Simulation {
	/** baseline parties, then extra parties on the ballot */
	partyIds: string[];
	baselineParties: string[];
	/** per region: vote share by party id */
	shares: Map<string, Record<string, number>>;
	/** per region: two-party D share after voter-group edits and appeals, before the uniform swing */
	lean: Map<string, number>;
	/** per region: number of voters */
	votes: Map<string, number>;
	/** whether every target was reached (no misses) */
	converged: boolean;
	/** targets the result misses by half a point or more, measured on the final result */
	misses: Miss[];
	/** the solver gave up before reaching every target (debugging aid; `misses` is what counts) */
	stalled: boolean;
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

/** a target the model could not meet: which party, which setting, wanted vs. got (0..1) */
export interface Miss {
	party: string;
	/** a target group, the extra party's "everyone else" share, or its D/R draw */
	kind: 'group' | 'elsewhere' | 'draws';
	filter?: Filter;
	target: number;
	got: number;
}
/** a target is met when it is within half a point (the panel shows whole percents) */
const MISS_TOLERANCE = 0.005;

interface Target { m: Uint8Array; t: number; x: number; filter: Filter }
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
	const { n, labels, parties: base } = b;
	const K = base.length;
	const ref = K - 1;
	const iD = base.indexOf('D'), iR = base.indexOf('R');
	/** which way the D/R tilt pushes each baseline party's voters */
	const side = base.map((p) => (p === 'D' ? 1 : p === 'R' ? -1 : 0));
	const fx = cellEffects(labels, { segments: sc.segments });

	// a. voter-group vote swings move the national matrix: points from R to D in the cell,
	//    applied to the cell's fitted national shares softmax(α) so a zero swing is a no-op
	const a0 = base.map(() => new Float64Array(n));
	{
		const r = new Float64Array(K), au = new Float64Array(K);
		for (let i = 0; i < n; i++) {
			for (let k = 0; k < K; k++) au[k] = b.alpha[k][i];
			softmax(au, r);
			const shift = fx[i].shift;
			if (shift && iD >= 0 && iR >= 0) {
				const pool = r[iD] + r[iR];
				const d = Math.min(pool, Math.max(0, r[iD] + shift * pool));
				r[iD] = d;
				r[iR] = pool - d;
			}
			for (let k = 0; k < K; k++) {
				// unedited cells keep the jointly fitted α exactly
				a0[k][i] = shift ? logRatio(r[k], r[ref]) : b.alpha[k][i];
			}
		}
	}

	// b. appeals by baseline parties: one utility shift per (party, group)
	const core: (Target & { k: number; id: string })[] = sc.parties
		.filter((p) => p.core && base.includes(p.id))
		.flatMap((p) =>
			p.appeals.map((a) => ({ id: p.id, k: base.indexOf(p.id), m: membership(labels, a.filter), t: a.share / 100, x: 0, filter: a.filter }))
		);
	// d. extra parties
	const extras: Extra[] = sc.parties
		.filter((p) => !p.core && !base.includes(p.id) && isLive(p))
		.map((p, j) => {
			const appeals = p.appeals.map((a) => ({ m: membership(labels, a.filter), t: a.share / 100, x: 0, filter: a.filter }));
			const outside = Uint8Array.from(labels, (_, i) => (appeals.some((a) => a.m[i]) ? 0 : 1));
			const out = p.share > 0 ? p.share / 100 : appeals.length ? null : 0;
			const baseX = out ? logit(out) : -LIM;
			for (const a of appeals) a.x = logit(Math.max(a.t, 1e-6)) - baseX;
			return { id: p.id, bit: 1 << j, runs: p.states.length ? new Set(p.states) : null, out, outside, appeals, fromD: p.fromD / 100, base: baseX, tilt: 0 };
		});
	const partyIds = [...base, ...extras.map((e) => e.id)];
	const E = extras.length;

	interface Row { rb: RegionBasis; Vp: Float64Array; S: Float64Array[]; L0: number; mask: number }
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
		rows.push({ rb, Vp, S: base.map(() => new Float64Array(n)), L0: twoPartyD(rb.actual), mask });
	}

	// per signature (set of extras on the ballot): each baseline party's voters, and all voters, per cell
	type Agg = { on: number[]; L: Float64Array[]; V: Float64Array };
	const aggs = new Map<number, Agg>();
	for (const row of rows) {
		if (!aggs.has(row.mask)) {
			aggs.set(row.mask, { on: extras.flatMap((e, j) => (row.mask & e.bit ? [j] : [])), L: base.map(() => new Float64Array(n)), V: new Float64Array(n) });
		}
	}

	const u = new Float64Array(K), pr = new Float64Array(K);
	function computeBase() {
		for (const a of aggs.values()) { for (const l of a.L) l.fill(0); a.V.fill(0); }
		const shift = base.map(() => new Float64Array(n));
		for (const t of core) for (let i = 0; i < n; i++) if (t.m[i]) shift[t.k][i] += t.x;
		for (const row of rows) {
			const { Vp, S, rb } = row;
			let dv = 0, pool = 0;
			for (let i = 0; i < n; i++) {
				for (let k = 0; k < K; k++) u[k] = a0[k][i] + shift[k][i] + rb.rho[k];
				softmax(u, pr);
				for (let k = 0; k < K; k++) S[k][i] = pr[k];
				if (iD >= 0 && iR >= 0) { dv += Vp[i] * pr[iD]; pool += Vp[i] * (pr[iD] + pr[iR]); }
			}
			// c. uniform swing: exactly swing/200 on the district's two-party D share, taken
			//    from voters still available
			row.L0 = pool ? dv / pool : twoPartyD(rb.actual);
			const L1 = Math.min(1, Math.max(0, row.L0 + sc.swing / 200));
			if (pool && L1 !== row.L0) {
				const up = L1 > row.L0;
				const k = up ? (L1 - row.L0) / (1 - row.L0) : (row.L0 - L1) / row.L0;
				for (let i = 0; i < n; i++) {
					const p = S[iD][i] + S[iR][i];
					if (!p) continue;
					let l = S[iD][i] / p;
					l = up ? l + (1 - l) * k : l * (1 - k);
					S[iD][i] = p * l;
					S[iR][i] = p * (1 - l);
				}
			}
			const a = aggs.get(row.mask)!;
			for (let i = 0; i < n; i++) {
				for (let k = 0; k < K; k++) a.L[k][i] += Vp[i] * S[k][i];
				a.V[i] += Vp[i];
			}
		}
	}

	/** η of extra e in cell i, before the tilt */
	const eta = (e: Extra, i: number) => {
		let x = e.base;
		for (const a of e.appeals) if (a.m[i]) x += a.x;
		return x;
	};
	/** defection odds exp(η) of each extra in `on`, for voters of baseline party k in cell i */
	const odds = (on: number[], i: number, k: number, out: Float64Array) => {
		let s = 1;
		for (const j of on) { const e = extras[j]; out[j] = Math.exp(clampLim(eta(e, i) + e.tilt * side[k])); s += out[j]; }
		return s;
	};

	/** national votes per cell for every party, the D-side part of each extra, and where-it-runs voters */
	function totals() {
		const votes: Record<string, Float64Array> = {};
		for (const id of partyIds) votes[id] = new Float64Array(n);
		const fromD = extras.map(() => new Float64Array(n));
		const runV = extras.map(() => new Float64Array(n));
		const allV = new Float64Array(n);
		const o = new Float64Array(E);
		for (const a of aggs.values()) {
			for (let i = 0; i < n; i++) {
				allV[i] += a.V[i];
				for (const j of a.on) runV[j][i] += a.V[i];
				for (let k = 0; k < K; k++) {
					const L = a.L[k][i];
					if (!L) continue;
					const s = odds(a.on, i, k, o);
					votes[base[k]][i] += L / s;
					for (const j of a.on) {
						const v = (L * o[j]) / s;
						votes[extras[j].id][i] += v;
						if (k === iD) fromD[j][i] += v;
					}
				}
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
	let stalled = false;
	const outer = core.length ? 40 : 1;
	let prevOuter = Infinity;
	for (let o = 0; o < outer; o++) {
		computeBase();
		let prevInner = Infinity;
		for (let it = 0; it < 200 && E; it++) {
			let worst = 0;
			extras.forEach((e, j) => {
				const step = (cur: number, t: number) => {
					if (!Number.isFinite(cur)) return 0;
					worst = Math.max(worst, Math.abs(cur - t));
					return logit(t) - logit(cur);
				};
				let T = totals();
				if (e.out !== null) e.base = clampLim(e.base + step(shareIn(T.votes[e.id], T.runV[j], e.outside), e.out));
				for (const a of e.appeals) {
					T = totals();
					a.x = clampLim(a.x + step(shareIn(T.votes[e.id], T.runV[j], a.m), a.t));
				}
				if (iD < 0 || iR < 0) return;
				if (e.fromD <= 0 || e.fromD >= 1) {
					e.tilt = e.fromD >= 1 ? LIM / 2 : -LIM / 2;
					return;
				}
				T = totals();
				const got = sum(T.votes[e.id]);
				if (got > 0) {
					const cur = sum(T.fromD[j]) / got;
					worst = Math.max(worst, Math.abs(cur - e.fromD));
					e.tilt = clampLim(e.tilt + 0.5 * (logit(e.fromD) - logit(cur)));
				}
			});
			if (worst < 1e-7) break;
			if (worst > prevInner * 0.999 || it === 199) { stalled = true; break; }
			prevInner = worst;
		}
		if (!core.length) break;
		const T = totals();
		let worst = 0;
		for (const t of core) {
			const cur = shareIn(T.votes[t.id], T.allV, t.m);
			if (!Number.isFinite(cur)) continue;
			worst = Math.max(worst, Math.abs(cur - t.t));
			t.x = clampLim(t.x + logit(t.t) - logit(cur));
		}
		if (worst < 1e-6) break;
		if (worst > prevOuter * 0.98 || o === outer - 1) { stalled = true; break; }
		prevOuter = worst;
	}

	// check every target on the final result
	const misses: Miss[] = [];
	{
		const T = totals();
		const check = (party: string, kind: Miss['kind'], target: number, got: number, filter?: Filter) => {
			if (Number.isFinite(got) && Math.abs(got - target) >= MISS_TOLERANCE) misses.push({ party, kind, filter, target, got });
		};
		for (const t of core) check(t.id, 'group', t.t, shareIn(T.votes[t.id], T.allV, t.m), t.filter);
		extras.forEach((e, j) => {
			if (e.out !== null) check(e.id, 'elsewhere', e.out, shareIn(T.votes[e.id], T.runV[j], e.outside));
			for (const a of e.appeals) check(e.id, 'group', a.t, shareIn(T.votes[e.id], T.runV[j], a.m), a.filter);
			const got = sum(T.votes[e.id]);
			if (got > 0 && iD >= 0 && iR >= 0) check(e.id, 'draws', e.fromD, sum(T.fromD[j]) / got);
		});
	}

	// final pass: per-region shares, national per-cell totals
	const shares = new Map<string, Record<string, number>>();
	const lean = new Map<string, number>();
	const votesBy = new Map<string, number>();
	const cellParty: Record<string, Float64Array> = Object.fromEntries(partyIds.map((id) => [id, new Float64Array(n)]));
	const cellV = new Float64Array(n), cellC = new Float64Array(n);
	const baseV = new Float64Array(n), baseC = new Float64Array(n);
	const baseP = base.map(() => new Float64Array(n));
	const o = new Float64Array(E);
	for (const row of rows) {
		const { Vp, S, rb, mask } = row;
		const on = extras.flatMap((e, j) => (mask & e.bit ? [j] : []));
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
				const s = odds(on, i, k, o);
				acc[base[k]] += L / s;
				cellParty[base[k]][i] += L / s;
				for (const j of on) {
					const v = (L * o[j]) / s;
					acc[extras[j].id] += v;
					cellParty[extras[j].id][i] += v;
				}
			}
			V += Vp[i];
			cellV[i] += Vp[i];
		}
		if (V > 0) for (const id of partyIds) acc[id] /= V;
		shares.set(rb.id, acc);
		lean.set(rb.id, row.L0);
		votesBy.set(rb.id, V);
	}

	const allV = sum(cellV), allBase = sum(baseV);
	return {
		partyIds,
		baselineParties: base,
		shares,
		lean,
		votes: votesBy,
		converged: misses.length === 0,
		misses,
		stalled,
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
