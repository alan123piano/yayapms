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
		const elections = m.elections.map(({ file, cellsFile, ...e }) => ({
			...e,
			results: JSON.parse(readFileSync(dir + file, 'utf8')).results,
			cells: cellsFile ? JSON.parse(readFileSync(dir + cellsFile, 'utf8')) : undefined
		}));
		return L.withElection(L.buildMap(m, L.parseGeo(readFileSync(dir + m.file, 'utf8')), { elections }), election);
	};
	const expect2020 = { 'us-house-current': 224, 'us-house-fair': 233 }; // from the original pipeline run
	const core = P.coreParties();
	const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

	const M = await vite.ssrLoadModule('/src/lib/model.ts');
	const ctxOf = (basis, regions, parties, swing = 0, segments = [], ov = {}) =>
		S.buildContext(basis, regions, { swing, segments, parties }, ov);
	const party = (o) => ({ id: 'p1', name: 'X', color: '#888888', share: 0, fromD: 50, states: [], appeals: [], ...o });

	for (const id of ['us-house-current', 'us-house-fair']) {
		for (const eid of ['pres-2020', 'pres-2024']) {
			const map = load(id, eid);
			const rs = map.regions.filter((r) => r.demShare !== null);
			const cells = map.elections.find((e) => e.id === eid).cells;
			const t0 = performance.now();
			const basis = M.fitBasis(map.regions, cells);
			const fitMs = performance.now() - t0;
			const n = basis.n;
			assert.equal(n, 80, 'cell count');
			if (eid === 'pres-2020') {
				assert.ok(map.regions.every((r) => geoArea(r.feature) < 2 * Math.PI), 'winding');
				const p = geoPath(geoAlbersUsa());
				assert.equal(map.regions.filter((r) => !p(r.feature)).length, 0, 'all project');
			}

			// 1. basis: cells add up to results; the fit reproduces districts AND national cell totals
			const natV = new Float64Array(n), natD = new Float64Array(n), fitD = new Float64Array(n);
			for (const r of rs) {
				let V = 0, D = 0;
				for (let i = 0; i < n; i++) { V += r.cells[n + i]; D += r.cells[2 * n + i]; }
				near(V, r.votes, 50, `${r.id} cell voters`);
				near(D, r.demShare * r.votes, 50, `${r.id} cell Dem votes`);
				const rb = basis.regions.get(r.id);
				let fd = 0;
				for (let i = 0; i < n; i++) {
					const p = 1 / (1 + Math.exp(-(basis.alpha[i] + rb.rho)));
					fd += rb.V[i] * p;
					natV[i] += rb.V[i]; natD[i] += rb.D[i]; fitD[i] += rb.V[i] * p;
				}
				near(fd / V, r.demShare, 1e-8, `${r.id}: basis reproduces the district`);
			}
			for (let i = 0; i < n; i++) if (natV[i] > 1000) near(fitD[i] / natV[i], natD[i] / natV[i], 1e-6, `cell ${i}: basis reproduces the national cell`);

			// 2. two-party: exactly the real result + uniform swing
			for (const sw of [-7, 0, 4.5]) {
				const ctx = ctxOf(basis, rs, core, sw);
				for (const r of rs) {
					const o = S.outcome(r, ctx);
					near(o.shares.D, Math.min(1, Math.max(0, r.demShare + sw / 200)), 1e-8, `${r.id} D share @${sw}`);
					assert.equal(o.level, S.levelFromMargin(S.margin(r.demShare, sw)), 'level');
				}
				assert.equal(S.tally(rs, ctx).seats.D, rs.filter((r) => S.margin(r.demShare, sw) > 0).length, `D seats @${sw}`);
			}
			const ctx0 = ctxOf(basis, rs, core);
			const t0s = S.tally(rs, ctx0);
			if (eid === 'pres-2020') assert.equal(t0s.seats.D, expect2020[id], '2020 D seats unchanged');
			const g0 = ctx0.sim.group({ age: ['18-29'] });
			near(g0.shares.D, g0.before.dem, 1e-6, 'matrix = real data with no edits');

			// 3. multiparty preset: shares sum to 1, targets hit, draws hit, regional stays regional
			const parties = P.presetParties(core);
			const ctx = ctxOf(basis, rs, parties);
			assert.ok(ctx.sim.converged, 'preset converges');
			let v = 0; const acc = {}; let vTX = 0, accTX = 0;
			for (const r of rs) {
				const sh = S.shares(r, ctx);
				near(Object.values(sh).reduce((a, b) => a + b, 0), 1, 1e-9, 'shares sum');
				assert.ok(Object.values(sh).every((x) => x >= 0), 'non-negative');
				const w = ctx.sim.votes.get(r.id);
				if (r.group !== 'TX') assert.equal(sh.p4 ?? 0, 0, 'regional party outside TX');
				else { vTX += w; accTX += w * sh.p4; }
				v += w;
				for (const [k, x] of Object.entries(sh)) acc[k] = (acc[k] ?? 0) + w * x;
			}
			for (const q of parties.filter((q) => !q.core && !q.states.length)) near(acc[q.id] / v, q.share / 100, 1e-5, `${q.name} national share`);
			near(accTX / vTX, 0.22, 1e-5, 'Lone Star TX share');
			const tm = S.tally(rs, ctx);

			// 4. a party with several target groups (overlapping) and a base level elsewhere
			const multi = party({ share: 3, fromD: 70, appeals: [{ filter: { age: ['18-29'] }, share: 30 }, { filter: { race: ['Hispanic'] }, share: 20 }] });
			const cm = ctxOf(basis, rs, [...core, multi]);
			assert.ok(cm.sim.converged, 'multi-appeal converges');
			near(cm.sim.group({ age: ['18-29'] }).shares.p1, 0.30, 1e-5, 'wins 30% of 18-29');
			near(cm.sim.group({ race: ['Hispanic'] }).shares.p1, 0.20, 1e-5, 'wins 20% of Hispanics');
			near(cm.sim.group({ age: ['30-44', '45-64', '65+'], race: ['White', 'Black', 'Asian', 'Other'] }).shares.p1, 0.03, 1e-5, '3% of everyone else');
			// group-only party: nothing outside its group
			const youth = party({ appeals: [{ filter: { sex: ['Men'], age: ['18-29'] }, share: 25 }] });
			const cy = ctxOf(basis, rs, [...core, youth]);
			near(cy.sim.group({ sex: ['Men'], age: ['18-29'] }).shares.p1, 0.25, 1e-5, 'wins 25% of young men');
			assert.ok(cy.sim.group({ sex: ['Women'] }).shares.p1 < 1e-9, 'nothing from women');
			const cyt = ctxOf(basis, rs, [...core, { ...youth, states: ['TX'] }]);
			assert.ok(rs.every((r) => r.group === 'TX' || !S.shares(r, cyt).p1), 'targeted party only where it runs');

			// 5. core appeal: D wins 75% of Hispanics (of all their votes)
			const dApp = core.map((p) => (p.id === 'D' ? { ...p, appeals: [{ filter: { race: ['Hispanic'] }, share: 75 }] } : p));
			const cd = ctxOf(basis, rs, dApp);
			assert.ok(cd.sim.converged, 'core appeal converges');
			near(cd.sim.group({ race: ['Hispanic'] }).shares.D, 0.75, 1e-5, 'D wins 75% of Hispanics');
			near(cd.sim.group({ race: ['White'] }).shares.D, ctx0.sim.group({ race: ['White'] }).shares.D, 1e-12, 'other groups untouched');
			// core appeal together with an extra party
			const cdx = ctxOf(basis, rs, [...dApp, multi]);
			near(cdx.sim.group({ race: ['Hispanic'] }).shares.D, 0.75, 1e-4, 'D appeal holds with a third party');
			near(cdx.sim.group({ race: ['Hispanic'] }).shares.p1, 0.20, 1e-4, 'third-party appeal holds with a D appeal');

			// 6. voter-group edits: a youth swing moves only young voters; turnout scales voters
			const seg = (f, vote, turnout = 0) => ({ id: 'c1', filter: f, vote, turnout });
			const cs = ctxOf(basis, rs, core, 0, [seg({ age: ['18-29'] }, 10)]);
			for (const g of ['30-44', '45-64', '65+']) near(cs.sim.group({ age: [g] }).shares.D, ctx0.sim.group({ age: [g] }).shares.D, 1e-12, `${g} untouched by youth swing`);
			const dy = (cs.sim.group({ age: ['18-29'] }).shares.D - g0.shares.D) * 200;
			assert.ok(dy > 7 && dy < 10.5, `youth +10 moves young voters ~10 margin points (${dy.toFixed(2)})`);
			const ct = ctxOf(basis, rs, core, 0, [seg({ age: ['18-29'] }, 0, 20)]);
			const r0 = rs[0], rb0 = basis.regions.get(r0.id);
			let V = 0, Y = 0;
			for (let c = 0; c < n; c++) { V += rb0.V[c]; if (basis.labels[c].age === '18-29') Y += Math.min(rb0.V[c] * 1.2, rb0.C[c] * 0.995); }
			near(ct.sim.votes.get(r0.id), V - [...Array(n).keys()].filter((c) => basis.labels[c].age === '18-29').reduce((a, c) => a + rb0.V[c], 0) + Y, 1e-6, 'youth turnout +20%');

			// demographics-only baseline: each cell at its national rate; national group shares unchanged
			const demo = M.demographicsOnly(basis);
			const cdemo = ctxOf(demo, rs, core);
			for (const r of rs) near(S.shares(r, cdemo).D, basis.regions.get(r.id).expected, 1e-9, `${r.id}: demographics-only district`);
			for (const f of [{}, { race: ['Black'] }, { age: ['18-29'], sex: ['Men'] }, { edu: ['College'] }]) {
				near(cdemo.sim.group(f).shares.D, ctx0.sim.group(f).shares.D, 1e-6, `demographics-only keeps national share of ${JSON.stringify(f)}`);
			}
			const tDemo = S.tally(rs, cdemo);
			const demoPopular = cdemo.sim.group({}).shares.D;

			// residuals: vote-weighted mean 0
			const res = rs.map((r) => M.residualPoints(basis.regions.get(r.id)));
			console.log(`${id} ${eid}: fit ${fitMs.toFixed(0)}ms | D ${t0s.seats.D} R ${t0s.seats.R} | preset: ` +
				Object.entries(tm.seats).map(([k, n]) => `${parties.find((q) => q.id === k).name} ${n}`).join(', ') +
				` | youth +10 -> D ${S.tally(rs, cs).seats.D} | demographics only: D ${tDemo.seats.D} R ${tDemo.seats.R} (D ${(demoPopular * 100).toFixed(1)}%) | residual sd ${Math.sqrt(res.reduce((a, x) => a + x * x, 0) / res.length).toFixed(1)} pts`);

			// overrides: an override for an inactive party is ignored
			assert.equal(S.outcome(r0, ctxOf(basis, rs, core, 0, [], { [r0.id]: { p: 'p2', l: 4 } })).manual, false);
			assert.equal(S.outcome(r0, ctxOf(basis, rs, parties, 0, [], { [r0.id]: { p: 'p2', l: 4 } })).winner, 'p2');
		}
	}

	// maps without demographic data: one "everyone" cell, same code path
	{
		const map = load('us-house-current', 'pres-2020');
		const plain = map.regions.map(({ cells, ...r }) => r);
		const basis = M.fitBasis(plain, undefined);
		const rs = plain.filter((r) => r.demShare !== null);
		const c = ctxOf(basis, rs, core, 3);
		for (const r of rs) near(S.shares(r, c).D, Math.min(1, r.demShare + 0.015), 1e-8, 'no-cells two-party');
		const cp = ctxOf(basis, rs, P.presetParties(core));
		assert.ok(cp.sim.converged, 'no-cells preset converges');
	}

	// legacy party links: a single `audience` becomes one appeal
	const leg = P.sanitizeParties([...P.coreParties(), { id: 'p1', name: 'Y', share: 25, fromD: 50, states: [], audience: { age: ['18-29'] } }]);
	assert.deepEqual(leg[2].appeals, [{ filter: { age: ['18-29'] }, share: 25 }]);
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
	assert.equal(sw.segments.length, 2, 'bad id / unknown dimension rejected');
	assert.equal(sw.segments[0].vote, 30, 'vote clamped');
	assert.deepEqual(sw.segments[1].filter, {}, 'unknown group dropped from filter');

	// 5. untrusted party configs
	assert.equal(P.sanitizeParties([{ id: 'D' }]), null, 'needs D and R');
	assert.equal(P.sanitizeParties([...P.coreParties(), { id: '<img>', name: 'x' }]), null, 'bad id');
	const s = P.sanitizeParties([...P.coreParties(), { id: 'p1', name: 'x'.repeat(99), color: 'red;background:url(x)', share: 999, fromD: -5, states: ['TX', '"><script>'] }]);
	assert.equal(s[2].color, '#888888'); assert.equal(s[2].name.length, 40); assert.equal(s[2].share, 60);
	assert.equal(s[2].fromD, 0); assert.deepEqual(s[2].states, ['TX']);

	// 6. import path
	const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { GEOID: 'x', NAME: 'X', G20PREDBID: 10, G20PRERTRU: 5 }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }] };
	const g = L.guessManifest(fc, 'test');
	assert.equal(g.manifest.idProperty, 'GEOID');
	assert.equal(g.dem, 'G20PREDBID');
	const m = L.buildMap(g.manifest, fc, { voteProps: { dem: g.dem, rep: g.rep } });
	near(m.regions[0].demShare, 2 / 3, 1e-9, 'import share');
	assert.throws(() => L.parseGeo('{"type":"Nope"}'));
	console.log('smoke OK');
} finally {
	await vite.close();
}
