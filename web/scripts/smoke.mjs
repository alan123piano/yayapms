// Smoke test: load real map packs through the app's loader + sim (via Vite SSR), check invariants.
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
	const L = await vite.ssrLoadModule('/src/lib/loader.ts');
	const S = await vite.ssrLoadModule('/src/lib/sim.ts');
	const P = await vite.ssrLoadModule('/src/lib/parties.ts');
	const G = await vite.ssrLoadModule('/src/lib/demographics.ts');
	const { geoArea, geoAlbersUsa, geoPath } = await import('d3-geo');
	const load = (id, election) => {
		const dir = `static/maps/${id}/`;
		const m = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8'));
		const cellsOf = (cellsFile) => {
			const head = JSON.parse(readFileSync(dir + cellsFile, 'utf8'));
			if (!head.bin) return head;
			const bin = readFileSync(dir + cellsFile.slice(0, cellsFile.lastIndexOf('/') + 1) + head.bin);
			return L.decodeCells(head, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
		};
		const elections = m.elections.map(({ file, cellsFile, ...e }) => ({
			...e,
			results: JSON.parse(readFileSync(dir + file, 'utf8')).results,
			cells: cellsFile ? cellsOf(cellsFile) : undefined
		}));
		const local = m.localFile ? JSON.parse(readFileSync(dir + m.localFile, 'utf8')) : undefined;
		return L.withElection(L.buildMap(m, L.parseGeo(readFileSync(dir + m.file, 'utf8')), { elections, local }), election);
	};
	const expect2020 = { 'us-house-current': 224, 'us-house-fair': 233 }; // from the original pipeline run
	const core = P.coreParties();
	const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

	const M = await vite.ssrLoadModule('/src/lib/model.ts');
	const ctxOf = (basis, regions, parties, segments = [], ov = {}) =>
		S.buildContext(basis, regions, { segments, parties }, ov);
	const party = (o) => ({ id: 'p1', name: 'X', color: '#888888', share: 0, states: [], appeals: [], ...o });
	/** a region's real share of a party */
	const real = (r, p = 'D') => r.baseline[p] / r.votes;

	for (const id of ['us-house-current', 'us-house-fair']) {
		for (const eid of ['pres-2020', 'pres-2024', 'house-2022', 'house-2026']) {
			const map = load(id, eid);
			const rs = map.regions.filter((r) => r.baseline);
			const cells = map.elections.find((e) => e.id === eid).cells;
			const t0 = performance.now();
			const basis = M.fitBasis(map.regions, cells, map.local);
			const fitMs = performance.now() - t0;
			const n = basis.n;
			assert.equal(n, Object.values(cells.dims).reduce((a, g) => a * g.length, 1), 'cell count');
			if (eid === 'pres-2020') {
				assert.ok(map.regions.every((r) => geoArea(r.feature) < 2 * Math.PI), 'winding');
				const p = geoPath(geoAlbersUsa());
				assert.equal(map.regions.filter((r) => !p(r.feature)).length, 0, 'all project');
			}

			// 1. basis: cells add up to results; the fit reproduces districts AND national cell totals
			const natV = new Float64Array(n), natD = new Float64Array(n), fitD = new Float64Array(n);
			let worstDistrict = 0;
			for (const r of rs) {
				let V = 0, D = 0;
				for (let i = 0; i < n; i++) { V += r.cells[n + i]; D += r.cells[2 * n + i]; }
				near(V, r.votes, 50, `${r.id} cell voters`);
				near(D, r.baseline.D, 50, `${r.id} cell Dem votes`);
				const rb = basis.regions.get(r.id);
				let fd = 0;
				for (let i = 0; i < n; i++) {
					const p = 1 / (1 + Math.exp(-(rb.u0[0][i] - rb.u0[1][i])));
					fd += rb.V[i] * p;
					natV[i] += rb.V[i]; natD[i] += rb.P[0][i]; fitD[i] += rb.V[i] * p;
				}
				const derr = Math.abs(fd / rb.V.reduce((a, x) => a + x, 0) - real(r));
				worstDistrict = Math.max(worstDistrict, derr);
				assert.ok(derr < 1e-6, `${r.id}: basis reproduces the district (${derr})`);
			}
			for (let i = 0; i < n; i++) if (natV[i] > 1000) near(fitD[i] / natV[i], natD[i] / natV[i], 1e-6, `cell ${i}: basis reproduces the national cell`);
			// ...and every state's race x education totals (the state layer)
			{
				const acc = {};
				for (const r of rs) {
					const rb = basis.regions.get(r.id);
					for (let i = 0; i < n; i++) {
						const l = basis.labels[i], key = `${r.group}|${l.race}|${l.edu}`;
						const a = (acc[key] ??= { v: 0, d: 0, f: 0 });
						a.v += rb.V[i]; a.d += rb.P[0][i]; a.f += rb.V[i] / (1 + Math.exp(-(rb.u0[0][i] - rb.u0[1][i])));
					}
				}
				for (const [key, a] of Object.entries(acc)) if (a.v > 2000) near(a.f / a.v, a.d / a.v, 1e-5, `${key}: state layer reproduces the state's class`);
			}

			// 2. no settings: exactly the real result, every party; outcomes follow the shares
			{
				const ctx = ctxOf(basis, rs, core);
				for (const r of rs) {
					const o = S.outcome(r, ctx);
					for (const q of Object.keys(r.baseline)) near(o.shares[q], real(r, q), 1e-6, `${r.id} ${q} share`);
					const [a1, a2] = Object.values(r.baseline).sort((x, y) => y - x);
					assert.equal(o.level, S.levelFromMargin(((a1 - a2) / r.votes) * 100), 'level');
				}
				assert.equal(S.tally(rs, ctx).seats.D, rs.filter((r) => r.baseline.D > r.baseline.R).length, 'D seats');
				// an appeal among everyone moves the party's national share by about that much
				const up = ctxOf(basis, rs, core.map((p) => (p.id === 'R' ? { ...p, appeals: [{ filter: {}, points: 3 }] } : p)));
				const dR = (up.sim.group({}).shares.R - ctx.sim.group({}).shares.R) * 100;
				near(dR, 3, 1e-4, 'R +3 among everyone moves R exactly 3 points nationally');
			}
			const ctx0 = ctxOf(basis, rs, core);
			const t0s = S.tally(rs, ctx0);
			if (eid === 'pres-2020') assert.equal(t0s.seats.D, expect2020[id], '2020 D seats unchanged');
			const g0 = ctx0.sim.group({ age: ['18-29'] });
			near(g0.shares.D, g0.before.shares.D, 1e-6, 'matrix = real data with no edits');

			// 3. multiparty preset: shares sum to 1, regional stays regional
			const parties = P.presetParties(core);
			const ctx = ctxOf(basis, rs, parties);
			for (const r of rs) {
				const sh = S.shares(r, ctx);
				near(Object.values(sh).reduce((a, b) => a + b, 0), 1, 1e-9, 'shares sum');
				assert.ok(Object.values(sh).every((x) => x >= 0), 'non-negative');
				if (r.group !== 'TX') assert.equal(sh.p4 ?? 0, 0, 'regional party outside TX');
			}
			const tm = S.tally(rs, ctx);
			// a new party with neutral pulls and no appeals wins exactly its base share everywhere
			const flat = ctxOf(basis, rs, [...core, party({ share: 12 })]);
			for (const r of rs.slice(0, 20)) near(S.shares(r, flat).p1, 0.12, 1e-9, `${r.id}: base share exact`);
			// the example parties with neutral pulls: every base share exact in every district it runs in
			const neutral = parties.map((p) => (p.core ? p : { ...p, pulls: undefined }));
			const cn = ctxOf(basis, rs, neutral);
			for (const r of rs) for (const q of neutral.filter((q) => !q.core)) {
				const runsHere = !q.states.length || q.states.includes(r.group);
				near(S.shares(r, cn)[q.id] ?? 0, runsHere ? q.share / 100 : 0, 1e-9, `${r.id}: ${q.name} base share exact`);
			}
			// two national parties with neutral pulls: each exactly its base share
			const two = ctxOf(basis, rs, [...core, party({ share: 10 }), party({ id: 'p2', share: 20 })]);
			near(two.sim.group({}).shares.p1, 0.10, 1e-9, 'two new parties: 10%');
			near(two.sim.group({}).shares.p2, 0.20, 1e-9, 'two new parties: 20%');
			// pulls: 100% from D takes only D voters
			const pullD = ctxOf(basis, rs, [...core, party({ share: 10, pulls: { D: 100, R: 0 } })]);
			near(pullD.sim.group({}).shares.R, ctx0.sim.group({}).shares.R, 1e-9, 'pulling only from D leaves R untouched');

			// 4. appeals: points at the baseline, only the group's cells move, they add up
			const app = (id, f, points) => core.map((p) => (p.id === id ? { ...p, appeals: [...p.appeals, { filter: f, points }] } : p));
			const cd = ctxOf(basis, rs, app('D', { race: ['Hispanic'] }, 10));
			const dh = (cd.sim.group({ race: ['Hispanic'] }).shares.D - ctx0.sim.group({ race: ['Hispanic'] }).shares.D) * 100;
			near(dh, 10, 1e-4, 'D +10 among Hispanics moves them exactly 10 points');
			for (const g of ['White', 'Black', 'Asian']) near(cd.sim.group({ race: [g] }).shares.D, ctx0.sim.group({ race: [g] }).shares.D, 1e-12, `${g} untouched`);
			const ym = ctxOf(basis, rs, [...core.map((p) => (p.id === 'D' ? { ...p, appeals: [{ filter: { age: ['18-29'] }, points: 5 }, { filter: { sex: ['Men'] }, points: 5 }] } : p))]);
			const both = ym.sim.group({ age: ['18-29'], sex: ['Men'] }).shares.D - ctx0.sim.group({ age: ['18-29'], sex: ['Men'] }).shares.D;
			const one = ym.sim.group({ age: ['18-29'], sex: ['Women'] }).shares.D - ctx0.sim.group({ age: ['18-29'], sex: ['Women'] }).shares.D;
			assert.ok(both > one * 1.5, 'young men get both appeals');
			const tiny = ctxOf(basis, rs, app('D', { age: ['18-29'] }, 0.25));
			const dt = (tiny.sim.group({ age: ['18-29'] }).shares.D - g0.shares.D) * 100;
			assert.ok(dt > 0 && dt < 0.3, `a 0.25-point appeal moves young voters < 0.3 pts, no jump (${dt.toFixed(3)})`);
			const cs = ctxOf(basis, rs, app('D', { age: ['18-29'] }, 5));

			// 5. fit to a share: finds the appeal, any party
			const sc0 = { segments: [], parties: core };
			const f1 = M.fitAppeal(basis, rs, sc0, 'D', { race: ['Hispanic'] }, 0.6);
			assert.ok(f1.reached, 'fit reached');
			const cf = ctxOf(basis, rs, app('D', { race: ['Hispanic'] }, f1.points));
			near(cf.sim.group({ race: ['Hispanic'] }).shares.D, 0.6, 0.002, `fit D to 60% of Hispanics (${f1.points} pts)`);
			const yp = [...core, party({ share: 3, pulls: { D: 60, R: 40 } })];
			const f2 = M.fitAppeal(basis, rs, { ...sc0, parties: yp }, 'p1', { age: ['18-29'] }, 0.25);
			const cy = ctxOf(basis, rs, yp.map((p) => (p.id === 'p1' ? { ...p, appeals: [{ filter: { age: ['18-29'] }, points: f2.points }] } : p)));
			near(cy.sim.group({ age: ['18-29'] }).shares.p1, 0.25, 0.002, 'fit a new party to 25% of 18-29');
			const txOnly = [...core, party({ share: 5, states: ['TX'] })];
			assert.equal(M.fitAppeal(basis, rs, { ...sc0, parties: txOnly }, 'p1', { race: ['Black'] }, 0.5).reached, false, 'unreachable fit says so (a Texas party, half of Black voters nationally)');

			// 6. turnout scales voters
			const seg = (f, turnout) => ({ id: 'c1', filter: f, turnout });
			const ct = ctxOf(basis, rs, core, [seg({ age: ['18-29'] }, 20)]);
			const r0 = rs[0], rb0 = basis.regions.get(r0.id);
			let V = 0, Y = 0;
			for (let c = 0; c < n; c++) { V += rb0.V[c]; if (basis.labels[c].age === '18-29') Y += Math.min(rb0.V[c] * 1.2, Math.max(rb0.V[c], rb0.C[c] * 0.995)); }
			const wantV = V - [...Array(n).keys()].filter((c) => basis.labels[c].age === '18-29').reduce((a, c) => a + rb0.V[c], 0) + Y;
			near(ct.sim.votes.get(r0.id) / wantV, 1, 1e-6, 'youth turnout +20%');

			// demographics-only baseline: each cell at its national rate; national group shares unchanged
			const demo = M.demographicsOnly(basis);
			const cdemo = ctxOf(demo, rs, core);
			for (const r of rs) near(S.shares(r, cdemo).D, basis.regions.get(r.id).expected.D, 1e-7, `${r.id}: demographics-only district`);
			for (const f of [{}, { race: ['Black'] }, { age: ['18-29'], sex: ['Men'] }, { edu: ['College'] }]) {
				near(cdemo.sim.group(f).shares.D, ctx0.sim.group(f).shares.D, 1e-6, `demographics-only keeps national share of ${JSON.stringify(f)}`);
			}
			const tDemo = S.tally(rs, cdemo);
			const demoPopular = cdemo.sim.group({}).shares.D;


			// MMP: list seats make the house proportional among eligible parties
			const mmp = (o) => ({ kind: 'mmp', listSeats: 100, threshold: 5, waiver: 1, overhang: 'level', ...o });
			const tf = S.tally(rs, ctx0, S.FPTP);
			assert.deepEqual(tf, S.tally(rs, ctx0), 'FPTP is the default');
			const tl = S.tally(rs, ctx, mmp({}));
			const elig = tl.mmp.eligible;
			const house = elig.reduce((a, id) => a + tl.seats[id], 0);
			const sl = S.sainteLague(Object.fromEntries(elig.map((id) => [id, tl.mmp.vote[id]])), house);
			for (const id of elig) assert.equal(tl.seats[id], sl[id], `MMP level: ${id} proportional`);
			for (const id of Object.keys(tl.seats)) assert.ok(tl.seats[id] >= tl.mmp.districts[id], 'keeps its districts');
			assert.ok(tl.mmp.extra >= 0, 'levelling only adds seats');
			const tk = S.tally(rs, ctx, mmp({ overhang: 'keep' }));
			assert.equal(tk.total - tk.unrated, rs.length * 2 + tk.mmp.extra, 'keep: base house plus overhang only');
			const th = S.tally(rs, ctxOf(basis, rs, [...core, party({ share: 3 })]), mmp({ threshold: 5, waiver: 0 }));
			assert.equal(th.mmp.list.p1, 0, 'under the threshold: no list seats');

			// residuals: vote-weighted mean 0
			const res = rs.map((r) => M.unexplained(basis.regions.get(r.id)).D);
			console.log(`${id} ${eid}: fit ${fitMs.toFixed(0)}ms | D ${t0s.seats.D} R ${t0s.seats.R} | preset: ` +
				Object.entries(tm.seats).map(([k, n]) => `${parties.find((q) => q.id === k).name} ${n}`).join(', ') +
				` | MMP: ${Object.entries(tl.seats).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' ')} of ${tl.total} | D +5 among 18-29 -> D ${S.tally(rs, cs).seats.D} | demographics only: D ${tDemo.seats.D} R ${tDemo.seats.R} (D ${(demoPopular * 100).toFixed(1)}%) | residual sd ${Math.sqrt(res.reduce((a, x) => a + x * x, 0) / res.length).toFixed(1)} pts`);

			// overrides: an override for an inactive party is ignored
			assert.equal(S.outcome(r0, ctxOf(basis, rs, core, [], { [r0.id]: { p: 'p2', l: 4 } })).manual, false);
			assert.equal(S.outcome(r0, ctxOf(basis, rs, parties, [], { [r0.id]: { p: 'p2', l: 4 } })).winner, 'p2');
		}
	}

	// three baseline parties: the fit is the same for every party (synthetic "L" party taken out
	// of R's cell votes, stronger among the young)
	{
		const map = load('us-house-current', 'pres-2024');
		const el = map.elections.find((e) => e.id === 'pres-2024');
		const labels = G.cellLabels(el.cells);
		const n = labels.length;
		const lRate = labels.map((l) => (l.age === '18-29' ? 0.3 : 0.08));
		const results = {}, base = {};
		for (const r of map.regions) {
			const c = r.cells;
			const L = labels.map((_, i) => (c[n + i] - c[2 * n + i]) * lRate[i]);
			results[r.id] = [...c.slice(0, 3 * n), ...L];
			const Ltot = L.reduce((a, b) => a + b, 0), D = r.baseline.D;
			base[r.id] = { D, L: Ltot, R: r.votes - D - Ltot };
		}
		const cells3 = { ...el.cells, parties: ['D', 'L', 'R'], results };
		const regions = map.regions.map((r) => ({ ...r, cells: results[r.id], baseline: base[r.id] }));
		const b3 = M.fitBasis(regions, cells3);
		assert.deepEqual(b3.parties, ['D', 'L', 'R']);
		const sim3 = M.simulate(b3, regions, { segments: [], parties: core });
		for (const r of regions) {
			const sh = sim3.shares.get(r.id);
			for (const q of ['D', 'L', 'R']) near(sh[q], base[r.id][q] / r.votes, 1e-7, `${r.id}: 3-party district ${q}`);
		}
		for (const f of [{ age: ['18-29'] }, { race: ['Black'] }, { age: ['65+'], edu: ['College'] }]) {
			const g = sim3.group(f);
			for (const q of ['D', 'L', 'R']) near(g.shares[q], g.before.shares[q], 1e-6, `3-party national ${q} among ${JSON.stringify(f)}`);
		}
		// appeals and extras work against any baseline party
		const sc3 = { segments: [], parties: [...core, party({ share: 5 })] };
		const fR = M.fitAppeal(b3, regions, sc3, 'R', { sex: ['Men'] }, 0.5);
		const s3 = M.simulate(b3, regions, { ...sc3, parties: sc3.parties.map((p) => (p.id === 'R' ? { ...p, appeals: [{ filter: { sex: ['Men'] }, points: fR.points }] } : p)) });
		near(s3.group({ sex: ['Men'] }).shares.R, 0.5, 0.002, '3-party: R fitted to 50% of men');
		const s3b = M.simulate(b3, regions, sc3);
		near(s3b.group({}).shares.p1, 0.05, 1e-9, '3-party: extra party exactly 5% with neutral pulls');
		console.log('three-party baseline OK');
	}

	// maps without demographic data: one "everyone" cell, same code path
	{
		const map = load('us-house-current', 'pres-2020');
		const plain = map.regions.map(({ cells, ...r }) => r);
		const basis = M.fitBasis(plain, undefined);
		const rs = plain.filter((r) => r.baseline);
		const c = ctxOf(basis, rs, core);
		for (const r of rs) near(S.shares(r, c).D, real(r), 1e-8, 'no-cells: real result');
		const cp = ctxOf(basis, rs, P.presetParties(core));
		assert.ok(rs.every((r) => Math.abs(Object.values(S.shares(r, cp)).reduce((a, b) => a + b, 0) - 1) < 1e-9), 'no-cells preset sums to 1');
	}

	// legacy party links: a single `audience` becomes one appeal
	const leg = P.sanitizeParties([...P.coreParties(), { id: 'p1', name: 'Y', share: 25, fromD: 70, states: [], audience: { age: ['18-29'] } }]);
	assert.deepEqual(leg[2].pulls, { D: 70, R: 30 }, 'older D-vs-R slider becomes pulls');
	assert.deepEqual(leg[2].appeals, [{ filter: { age: ['18-29'] }, points: 0, target: 25 }], 'legacy audience -> a target to fit');
	const leg2 = P.sanitizeParties([...P.coreParties(), { id: 'p1', name: 'Y', share: 5, fromD: 50, states: [], appeals: [{ filter: { race: ['Hispanic'] }, share: 30 }, { filter: {}, points: 4 }, { filter: { planet: 'x' }, points: 3 }] }]);
	assert.deepEqual(leg2[2].appeals, [{ filter: { race: ['Hispanic'] }, points: 0, target: 30 }, { filter: {}, points: 4 }], 'targets kept for fitting; points kept; malformed dropped');
	assert.equal(leg[2].share, 0, 'legacy audience party wins nothing elsewhere');

	// voter-group links and keys
	assert.equal(G.filterKey({ sex: ['Men'], age: ['30-44', '18-29'] }), G.filterKey({ age: ['18-29', '30-44'], sex: ['Men'] }), 'filterKey order-independent');
	const dims = { age: ['18-29', '30-44'], sex: ['Men', 'Women'] };
	const sw = G.sanitizeSwing({ segments: [
		{ id: 'c1', filter: { age: ['18-29'], sex: ['Men'] }, vote: 99, turnout: 5, custom: true },
		{ id: 'c2', filter: { age: ['<script>'] }, vote: 5 },
		{ id: '"><x', filter: {}, vote: 5 },
		{ id: 'c3', filter: { planet: ['Mars'] }, vote: 5 }
	] }, dims, { vote: 30, turnout: 50 });
	assert.equal(sw.swing.segments.length, 2, 'bad id / unknown dimension rejected');
	assert.equal(sw.votes[0].vote, 30, 'older vote swing clamped and returned for conversion');
	assert.deepEqual(sw.swing.segments[1].filter, {}, 'unknown group dropped from filter');

	// 5. untrusted party configs
	assert.equal(P.sanitizeParties([{ id: 'D' }])?.[0].core, true, 'any party of the data is core');
	assert.equal(P.sanitizeParties([{ id: 'p7' }])?.[0].core, false, 'added parties are not');
	assert.equal(P.sanitizeParties([...P.coreParties(), { id: '<img>', name: 'x' }]), null, 'bad id');
	const s = P.sanitizeParties([...P.coreParties(), { id: 'p1', name: 'x'.repeat(99), color: 'red;background:url(x)', share: 999, fromD: -5, states: ['TX', '"><script>'] }]);
	assert.equal(s[2].color, '#888888'); assert.equal(s[2].name.length, 40); assert.equal(s[2].share, 60);
	assert.deepEqual(s[2].pulls, { D: 0, R: 100 }); assert.deepEqual(s[2].states, ['TX']);

	// 6. import path
	const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { GEOID: 'x', NAME: 'X', G20PREDBID: 10, G20PRERTRU: 5 }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }] };
	const g = L.guessManifest(fc, 'test');
	assert.equal(g.manifest.idProperty, 'GEOID');
	assert.equal(g.dem, 'G20PREDBID');
	const m = L.buildMap(g.manifest, fc, { voteProps: { dem: g.dem, rep: g.rep } });
	near(real(m.regions[0]), 2 / 3, 1e-9, 'import share');
	assert.throws(() => L.parseGeo('{"type":"Nope"}'));
	console.log('smoke OK');
} finally {
	await vite.close();
}
