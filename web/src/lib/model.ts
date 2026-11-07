import { cellEffects, cellLabels, filterKey, matches, type Filter, type Segment } from './demographics';
import type { CellData, LocalData, Party, Region } from './types';

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
	/** per baseline party (Basis.parties order), per cell: real votes (scaled to the official totals) */
	P: Float64Array[];
	/** per baseline party, per cell: baseline utility, the sum of every layer (national matrix +
	 *  state pattern + district residual); the simulation starts from softmax(u0) */
	u0: Float64Array[];
	/** per baseline party: district residual vs. its state (log-odds vs the reference party;
	 *  vote-weighted mean 0 within each state) */
	rho: Float64Array;
	/** per baseline party: the part of rho that local factors and neighboring districts explain */
	rhoHat: Float64Array;
	/** per baseline party: real share */
	actual: Record<string, number>;
	/** per baseline party: the share if every cell voted at its national rate (demographics alone) */
	expected: Record<string, number>;
	/** what each layer of the model explains, in order: each stage's predicted shares per party;
	 *  the gap between the last stage and `actual` is the unexplained residual */
	stages: { id: StageId; shares: Record<string, number> }[];
}

/** layers of the model, in the order they explain a district's result */
export type StageId = 'demographics' | 'state' | 'local' | 'neighbors';
export const STAGE_LABELS: Record<StageId, string> = {
	demographics: 'Demographics',
	state: 'State patterns',
	local: 'Local factors',
	neighbors: 'Neighboring districts'
};

export interface Basis {
	n: number;
	labels: Record<string, string>[];
	/** the baseline election's parties; the last is the reference */
	parties: string[];
	/** per party, per cell: national utility (fitted jointly with the other layers) */
	alpha: Float64Array[];
	/** per party, per cell: national vote rate */
	rate: Float64Array[];
	/** per cell: national voters (weights for a group's baseline share) */
	voters: Float64Array;
	regions: Map<string, RegionBasis>;
	/** how well the layers beyond demographics explain the district residual */
	fit: BasisFit;
}

export interface BasisFit {
	/** spread (vote-weighted sd) of the D-vs-R margin residual after each layer, in points */
	spread: { id: StageId | 'unexplained'; points: number }[];
	/** local factors: cross-validated share of the within-state residual they explain, and each
	 *  factor's effect on the D-vs-R margin per standard deviation of the factor (points) */
	local: { r2: number; effects: { id: string; label: string; points: number }[] } | null;
	/** neighbors: how much of a district's remaining residual follows its neighbors' (0..1) */
	neighbors: { weight: number } | null;
}

/** Baseline parties of an election with demographic cells (older files: D, then R). */
export const cellParties = (cells?: CellData) => cells?.parties ?? ['D', 'R'];

/** Two-party D share of a per-party record. */
export const twoPartyD = (x: Record<string, number>) => (x.D + x.R > 0 ? x.D / (x.D + x.R) : 0);

/** the dimensions whose state-specific pattern the state layer learns */
const STATE_LAYER_DIMS = ['race', 'edu'];

/**
 * Fit the basis: party k's utility in cell c of district d (state s) is
 *     α_k,c + γ_k,s,q(c) + ρ_k,d
 * α the national matrix, γ the state pattern for the cell's race x education class q (e.g.
 * Southern white non-college voters), ρ the district's residual vs. its state. Fitted jointly
 * (maximum likelihood with cell, state x class and district fixed effects) so that real district
 * results, national per-cell totals and per-state race x education totals all hold exactly.
 */
export function fitBasis(regions: Region[], cells?: CellData, local?: LocalData): Basis {
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
		return { C: Float64Array.from(c.slice(0, n)), V, P };
	};
	const compV = new Float64Array(n);
	const compP = parties.map(() => new Float64Array(n));
	for (const r of rated) {
		if (!cells || !r.cells) continue;
		const { V, P } = cellVotes(r);
		for (let i = 0; i < n; i++) { compV[i] += V[i]; for (let k = 0; k < ref; k++) compP[k][i] += P[k][i]; }
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
			P = parties.map((_, k) => V.map((v, i) => (k < ref && compV[i] ? (v * compP[k][i]) / compV[i] : 0)));
		} else {
			V = Float64Array.of(tot);
			P = off.map((x) => Float64Array.of(x));
		}
		// scale the cells to the official totals (they differ by rounding, ≤ ~50 votes a
		// district), so every total the fit matches comes from one consistent table
		const kV = tot / (sum(V) || 1);
		for (let i = 0; i < n; i++) V[i] *= kV;
		for (let k = 0; k < ref; k++) {
			const kP = off[k] / (sum(P[k]) || 1);
			for (let i = 0; i < n; i++) P[k][i] = Math.min(V[i], P[k][i] * kP);
		}
		for (let i = 0; i < n; i++) {
			let s = 0;
			for (let k = 0; k < ref; k++) s += P[k][i];
			P[ref][i] = Math.max(0, V[i] - s);
		}
		const u0 = parties.map(() => new Float64Array(n));
		return { id: r.id, group: r.group, V, C, P, u0, rho: new Float64Array(K), rhoHat: new Float64Array(K), actual, expected: { ...actual }, stages: [] };
	});

	const tot = rows.map((r) => sum(r.V));
	const Vc = new Float64Array(n);
	for (const r of rows) for (let i = 0; i < n; i++) Vc[i] += r.V[i];
	const T = parties.map((_, k) => {
		const t = new Float64Array(n);
		for (const r of rows) for (let i = 0; i < n; i++) t[i] += r.P[k][i];
		return t;
	});
	const rate = T.map((t) => Float64Array.from(t, (x, i) => (Vc[i] > 0 ? x / Vc[i] : 0)));
	const alpha = parties.map((_, k) => Float64Array.from(rate[k], (p, i) => logRatio(p, rate[ref][i])));

	// state layer: class q of each cell (its race x education combination), state s of each row
	const qDims = STATE_LAYER_DIMS.filter((d) => d in (labels[0] ?? {}));
	const qKeys = [...new Set(labels.map((l) => qDims.map((d) => l[d]).join('|')))];
	const Q = qKeys.length;
	const qOf = Int32Array.from(labels, (l) => qKeys.indexOf(qDims.map((d) => l[d]).join('|')));
	const states = [...new Set(rows.map((r) => r.group))];
	const sOf = Int32Array.from(rows, (r) => states.indexOf(r.group));
	const rowsOf = states.map((_, s) => rows.flatMap((r, j) => (sOf[j] === s ? [j] : [])));
	const cellsOf = Array.from({ length: Q }, (_, q) => [...Array(n).keys()].filter((i) => qOf[i] === q));
	const gamma = parties.map(() => new Float64Array(states.length * Q));
	const S = parties.map((_, k) => {
		const t = new Float64Array(states.length * Q);
		rows.forEach((r, j) => { for (let i = 0; i < n; i++) t[sOf[j] * Q + qOf[i]] += r.P[k][i]; });
		return t;
	});
	const SV = new Float64Array(states.length * Q);
	rows.forEach((r, j) => { for (let i = 0; i < n; i++) SV[sOf[j] * Q + qOf[i]] += r.V[i]; });

	const u = new Float64Array(K), pr = new Float64Array(K);
	const probs = (j: number, i: number) => {
		const r = rows[j], g = sOf[j] * Q + qOf[i];
		for (let k = 0; k < K; k++) u[k] = alpha[k][i] + gamma[k][g] + r.rho[k];
		return softmax(u, pr);
	};
	/** one Newton step for a parameter: f = Σ V p_k - target over (row, cell) pairs */
	const newton = (pairs: (visit: (j: number, i: number) => void) => void, k: number, target: number) => {
		let f = -target, df = 0;
		pairs((j, i) => {
			const v = rows[j].V[i];
			if (!v) return;
			const p = probs(j, i)[k];
			f += v * p;
			df += v * p * (1 - p);
		});
		return { f, step: df > 1e-12 ? f / df : 0 };
	};
	for (let sweep = 0; sweep < 2000 && K > 1; sweep++) {
		let worst = 0;
		// districts: real votes of each party
		rows.forEach((r, j) => {
			for (let k = 0; k < ref; k++) {
				for (let step = 0; step < 2; step++) {
					const { f, step: d } = newton((visit) => { for (let i = 0; i < n; i++) visit(j, i); }, k, r.P[k].reduce((a, x) => a + x, 0));
					if (step === 0) worst = Math.max(worst, Math.abs(f) / tot[j]);
					r.rho[k] = clampLim(r.rho[k] - d);
				}
			}
		});
		// cells: national votes of each party in the cell
		for (let i = 0; i < n; i++) {
			if (!(Vc[i] > 0)) continue;
			for (let k = 0; k < ref; k++) {
				if (rate[k][i] <= 0 || rate[ref][i] <= 0) continue; // fixed at its boundary
				for (let step = 0; step < 2; step++) {
					const { f, step: d } = newton((visit) => { for (let j = 0; j < rows.length; j++) visit(j, i); }, k, T[k][i]);
					if (step === 0) worst = Math.max(worst, Math.abs(f) / Vc[i]);
					alpha[k][i] = clampLim(alpha[k][i] - d);
				}
			}
		}
		// state x class: each state's votes of each party among, e.g., white non-college voters
		if (states.length > 1) {
			for (let s = 0; s < states.length; s++) {
				for (let q = 0; q < Q; q++) {
					const g = s * Q + q;
					if (!(SV[g] > 0)) continue;
					for (let k = 0; k < ref; k++) {
						if (S[k][g] <= 0 || S[ref][g] <= 0) continue;
						const { f, step: d } = newton((visit) => { for (const j of rowsOf[s]) for (const i of cellsOf[q]) visit(j, i); }, k, S[k][g]);
						worst = Math.max(worst, Math.abs(f) / SV[g]);
						gamma[k][g] = clampLim(gamma[k][g] - d);
					}
				}
			}
		}
		if (worst < 1e-10) break;
	}

	// The layers fit equally well under shifts between them. Convention: ρ has mean 0 within
	// each state (a state's overall lean belongs to its state pattern), and γ has mean 0 across
	// states for each class (the national pattern belongs to α). Vote-weighted.
	for (let k = 0; k < ref; k++) {
		for (let s = 0; s < states.length; s++) {
			const w = rowsOf[s].reduce((a, j) => a + tot[j], 0);
			const c = w ? rowsOf[s].reduce((a, j) => a + rows[j].rho[k] * tot[j], 0) / w : 0;
			for (const j of rowsOf[s]) rows[j].rho[k] -= c;
			for (let q = 0; q < Q; q++) gamma[k][s * Q + q] += c;
		}
		for (let q = 0; q < Q; q++) {
			let w = 0, c = 0;
			for (let s = 0; s < states.length; s++) { w += SV[s * Q + q]; c += SV[s * Q + q] * gamma[k][s * Q + q]; }
			c = w ? c / w : 0;
			for (let s = 0; s < states.length; s++) gamma[k][s * Q + q] -= c;
			for (const i of cellsOf[q]) alpha[k][i] += c;
		}
	}

	// local factors and neighbors: explain the within-state residual (layers 3 and 4)
	const localFit = explainResidual(rows, tot, sOf, K, local);

	// baseline utilities and what each layer explains
	const shareOf = (r: RegionBasis, j: number, util: (k: number, i: number) => number) => {
		const acc = new Float64Array(K);
		for (let i = 0; i < n; i++) {
			if (!r.V[i]) continue;
			for (let k = 0; k < K; k++) u[k] = util(k, i);
			softmax(u, pr);
			for (let k = 0; k < K; k++) acc[k] += r.V[i] * pr[k];
		}
		return Object.fromEntries(parties.map((p, k) => [p, tot[j] ? acc[k] / tot[j] : 0]));
	};
	rows.forEach((r, j) => {
		const g = (i: number) => sOf[j] * Q + qOf[i];
		for (let k = 0; k < K; k++) for (let i = 0; i < n; i++) r.u0[k][i] = alpha[k][i] + gamma[k][g(i)] + r.rho[k];
		r.expected = Object.fromEntries(parties.map((p, k) => {
			let e = 0;
			for (let i = 0; i < n; i++) e += r.V[i] * rate[k][i];
			return [p, tot[j] ? e / tot[j] : r.actual[p]];
		}));
		const base = (k: number, i: number) => alpha[k][i] + gamma[k][g(i)];
		r.stages = [
			{ id: 'demographics', shares: r.expected },
			...(states.length > 1 ? [{ id: 'state' as const, shares: shareOf(r, j, base) }] : []),
			...(localFit.local ? [{ id: 'local' as const, shares: shareOf(r, j, (k, i) => base(k, i) + localFit.localPart[j][k]) }] : []),
			...(localFit.neighbors ? [{ id: 'neighbors' as const, shares: shareOf(r, j, (k, i) => base(k, i) + r.rhoHat[k]) }] : [])
		];
	});
	const regionsMap = new Map(rows.map((r) => [r.id, r]));
	const ids: (StageId | 'unexplained')[] = [...(rows[0]?.stages.map((x) => x.id) ?? []), 'unexplained'];
	const spread = ids.map((id) => {
		const res = rows.map((r) => {
			const st = id === 'unexplained' ? null : r.stages.find((x) => x.id === id);
			return margin2(r.actual) - (st ? margin2(st.shares) : margin2(r.actual));
		});
		return { id, points: wsd(res, tot) };
	});
	return {
		n, labels, parties, alpha, rate, voters: Vc, regions: regionsMap,
		fit: { spread: spread.slice(0, -1), local: localFit.local, neighbors: localFit.neighbors }
	};
}

/** vote-weighted standard deviation around 0 */
function wsd(x: number[], w: number[]): number {
	const W = w.reduce((a, b) => a + b, 0);
	return W ? Math.sqrt(x.reduce((a, v, i) => a + w[i] * v * v, 0) / W) : 0;
}

/** Solve (A + λI) x = b for a small dense symmetric system. */
function solve(A: number[][], b: number[], lambda: number): number[] {
	const n = b.length;
	const M = A.map((row, i) => [...row.map((v, j) => v + (i === j ? lambda : 0)), b[i]]);
	for (let p = 0; p < n; p++) {
		let mx = p;
		for (let r = p + 1; r < n; r++) if (Math.abs(M[r][p]) > Math.abs(M[mx][p])) mx = r;
		[M[p], M[mx]] = [M[mx], M[p]];
		if (Math.abs(M[p][p]) < 1e-12) continue;
		for (let r = 0; r < n; r++) {
			if (r === p) continue;
			const f = M[r][p] / M[p][p];
			for (let c = p; c <= n; c++) M[r][c] -= f * M[p][c];
		}
	}
	return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

/** weighted ridge regression of y on X (columns already standardized, no intercept needed) */
function ridge(X: number[][], y: number[], w: number[], lambda: number): number[] {
	const p = X[0]?.length ?? 0;
	const A = Array.from({ length: p }, () => new Array(p).fill(0));
	const b = new Array(p).fill(0);
	X.forEach((x, i) => {
		for (let a = 0; a < p; a++) {
			b[a] += w[i] * x[a] * y[i];
			for (let c = 0; c < p; c++) A[a][c] += w[i] * x[a] * x[c];
		}
	});
	return solve(A, b, lambda);
}

/**
 * Layers 3 and 4: regress each party's within-state residual ρ on the region's local factors
 * (each demeaned within its state and standardized, so they explain differences between
 * districts of the same state), ridge-penalized with the penalty picked by 5-fold
 * cross-validation; then the part left over is partly shared with neighboring districts:
 * e_d ≈ w · mean(e over d's neighbors), w fitted by weighted least squares in [0, 1].
 * Writes rhoHat (local + neighbor part) on each row.
 */
function explainResidual(
	rows: RegionBasis[], tot: number[], sOf: Int32Array, K: number, local?: LocalData
): { local: BasisFit['local']; neighbors: BasisFit['neighbors']; localPart: Float64Array[] } {
	const ref = K - 1;
	const R = rows.length;
	const localPart = rows.map(() => new Float64Array(K));
	const none = { local: null, neighbors: null, localPart };
	if (!local || R < 30 || K < 2) return none;
	const F = local.factors.length;
	const raw = rows.map((r) => local.values[r.id]);
	if (raw.some((v) => !v || v.length !== F)) return none;
	const w = tot.map((t) => t / (tot.reduce((a, b) => a + b, 0) / R)); // mean weight 1

	// demean within state, then standardize (weighted)
	const X = raw.map((v) => [...v]);
	const nS = Math.max(...sOf) + 1;
	for (let f = 0; f < F; f++) {
		const m = new Float64Array(nS), ws = new Float64Array(nS);
		X.forEach((x, j) => { m[sOf[j]] += w[j] * x[f]; ws[sOf[j]] += w[j]; });
		X.forEach((x, j) => { x[f] -= ws[sOf[j]] ? m[sOf[j]] / ws[sOf[j]] : 0; });
		const sd = Math.sqrt(X.reduce((a, x, j) => a + w[j] * x[f] * x[f], 0) / R) || 1;
		X.forEach((x) => { x[f] /= sd; });
	}
	// pick the ridge penalty by 5-fold cross-validation on the D-vs-R residual (or party 0's)
	const target = (k: number) => rows.map((r) => r.rho[k]);
	const lambdas = [0.3, 1, 3, 10, 30, 100, 300, 1000];
	const cvR2 = (y: number[], lambda: number) => {
		let ss = 0, sr = 0;
		for (let fold = 0; fold < 5; fold++) {
			const tr = [...Array(R).keys()].filter((j) => j % 5 !== fold);
			const beta = ridge(tr.map((j) => X[j]), tr.map((j) => y[j]), tr.map((j) => w[j]), lambda);
			for (let j = fold; j < R; j += 5) {
				const p = X[j].reduce((a, x, f) => a + x * beta[f], 0);
				sr += w[j] * (y[j] - p) ** 2;
				ss += w[j] * y[j] ** 2;
			}
		}
		return ss ? 1 - sr / ss : 0;
	};
	const y0 = target(0);
	let best = lambdas[0], bestR2 = -Infinity;
	for (const l of lambdas) {
		const r2 = cvR2(y0, l);
		if (r2 > bestR2) { bestR2 = r2; best = l; }
	}
	const betas: number[][] = [];
	for (let k = 0; k < ref; k++) {
		const beta = ridge(X, target(k), w, best);
		betas.push(beta);
		rows.forEach((r, j) => { localPart[j][k] = X[j].reduce((a, x, f) => a + x * beta[f], 0); });
	}
	// a factor's effect on the D-vs-R margin per sd: logit change ≈ 4 x share change at 50%,
	// x 200 margin points per share; reported for the D vs R pair (log-odds of D vs R)
	const effects = local.factors.map((f, i) => ({ id: f.id, label: f.label, points: (betas[0]?.[i] ?? 0) * 50 }));

	// neighbors
	const index = new Map(rows.map((r, j) => [r.id, j]));
	const e = rows.map((r, j) => Float64Array.from({ length: K }, (_, k) => (k < ref ? r.rho[k] - localPart[j][k] : 0)));
	const nb = rows.map((r) => (local.neighbors?.[r.id] ?? []).map((id) => index.get(id)).filter((x): x is number => x !== undefined));
	let neighbors: BasisFit['neighbors'] = null;
	const weightOf: number[] = [];
	if (nb.some((x) => x.length)) {
		for (let k = 0; k < ref; k++) {
			let sxy = 0, sxx = 0;
			rows.forEach((_, j) => {
				if (!nb[j].length) return;
				const m = nb[j].reduce((a, q) => a + e[q][k], 0) / nb[j].length;
				sxy += w[j] * m * e[j][k];
				sxx += w[j] * m * m;
			});
			weightOf.push(sxx ? Math.min(1, Math.max(0, sxy / sxx)) : 0);
		}
		neighbors = { weight: weightOf[0] ?? 0 };
	}
	rows.forEach((r, j) => {
		for (let k = 0; k < ref; k++) {
			const m = nb[j].length ? nb[j].reduce((a, q) => a + e[q][k], 0) / nb[j].length : 0;
			r.rhoHat[k] = localPart[j][k] + (weightOf[k] ?? 0) * m;
		}
	});
	return { local: { r2: Math.max(0, bestR2), effects }, neighbors, localPart };
}

/**
 * The demographics-only baseline: every cell votes at its national rate in every district
 * (no state pattern, no residual). National totals and each group's national share are
 * unchanged; districts differ only by who lives there.
 */
export function demographicsOnly(b: Basis): Basis {
	const ref = b.parties.length - 1;
	const u0 = b.rate.map((rk) => Float64Array.from(rk, (p, i) => logRatio(p, b.rate[ref][i])));
	const regions = new Map(
		[...b.regions].map(([id, r]) => [
			id,
			{
				...r,
				u0,
				rho: new Float64Array(b.parties.length),
				actual: { ...r.expected },
				P: b.rate.map((rk) => r.V.map((v, i) => v * rk[i])),
				stages: r.stages.slice(0, 1)
			}
		])
	);
	return { ...b, regions };
}

/** versions of an election the simulation can start from */
export type BaselineVariant = 'real' | 'model' | 'demographics';
export const BASELINE_VARIANTS: { id: BaselineVariant; label: string; hint: string }[] = [
	{ id: 'real', label: 'real result', hint: 'The real result in every district' },
	{ id: 'model', label: 'model only', hint: 'What demographics, state patterns, local factors and neighbors explain, without the unexplained district residual' },
	{ id: 'demographics', label: 'demographics only', hint: 'Every voter group votes at its national rate in every district' }
];

/** The basis for a baseline variant. */
export function baselineFor(b: Basis, variant: BaselineVariant): Basis {
	return variant === 'model' ? modelOnly(b) : variant === 'demographics' ? demographicsOnly(b) : b;
}

/**
 * The model-only baseline: every layer the model explains (demographics, state patterns, local
 * factors, neighbors) but not the unexplained district residual.
 */
export function modelOnly(b: Basis): Basis {
	const regions = new Map(
		[...b.regions].map(([id, r]) => {
			const u0 = r.u0.map((uk, k) => uk.map((x) => x - r.rho[k] + r.rhoHat[k]));
			const last = r.stages[r.stages.length - 1]?.shares ?? r.actual;
			// real votes become the model's: per cell, V x softmax(u0)
			const P = b.parties.map(() => new Float64Array(b.n));
			const u = new Float64Array(b.parties.length), pr = new Float64Array(b.parties.length);
			for (let i = 0; i < b.n; i++) {
				for (let k = 0; k < u.length; k++) u[k] = u0[k][i];
				softmax(u, pr);
				for (let k = 0; k < u.length; k++) P[k][i] = r.V[i] * pr[k];
			}
			return [id, { ...r, u0, rho: Float64Array.from(r.rhoHat), actual: { ...last }, P }];
		})
	);
	return { ...b, regions };
}

const margin2 = (x: Record<string, number>) => ((x.D ?? 0) - (x.R ?? 0)) * 100;

/** District residual in D-vs-R margin points: real minus what every modeled layer predicts (+ = more D). */
export function residualPoints(r: RegionBasis): number {
	const last = r.stages[r.stages.length - 1]?.shares ?? r.expected;
	return margin2(r.actual) - margin2(last);
}

/** D-vs-R margin points each layer adds, demographics first, then the unexplained rest. */
export function decomposition(r: RegionBasis): { id: StageId | 'unexplained'; points: number }[] {
	const out: { id: StageId | 'unexplained'; points: number }[] = [];
	let prev = 0;
	for (const s of r.stages) {
		const m = margin2(s.shares);
		out.push({ id: s.id, points: m - prev });
		prev = m;
	}
	out.push({ id: 'unexplained', points: margin2(r.actual) - prev });
	return out;
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
		// a turnout increase can't take a cell past 99.5% of its citizens of voting age (or past
		// its real voters, if those already exceed that); no change leaves it as it is
		const Vp = rb.V.map((v, i) => {
			const m = fx[i].mult;
			if (m <= 1 || !rb.C) return v * m;
			return Math.min(v * m, Math.max(v, rb.C[i] * 0.995));
		});
		// baseline parties: softmax of the baseline utility (every layer) + appeals
		let dv = 0, pool = 0;
		for (let i = 0; i < n; i++) {
			for (let k = 0; k < K; k++) u[k] = rb.u0[k][i] + shift[k][i];
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
