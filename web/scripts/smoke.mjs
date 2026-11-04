// Smoke test: load real map packs through the app's loader + sim (via Vite SSR), check invariants.
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
	const L = await vite.ssrLoadModule('/src/lib/loader.ts');
	const S = await vite.ssrLoadModule('/src/lib/sim.ts');
	const P = await vite.ssrLoadModule('/src/lib/parties.ts');
	const { geoArea, geoAlbersUsa, geoPath } = await import('d3-geo');
	const load = (id, election) => {
		const dir = `static/maps/${id}/`;
		const m = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8'));
		const elections = m.elections.map(({ file, ...e }) => ({ ...e, results: JSON.parse(readFileSync(dir + file, 'utf8')).results }));
		return L.withElection(L.buildMap(m, L.parseGeo(readFileSync(dir + m.file, 'utf8')), { elections }), election);
	};
	const expect2020 = { 'us-house-current': 224, 'us-house-fair': 233 }; // from the original pipeline run
	const core = P.coreParties();
	const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

	for (const id of ['us-house-current', 'us-house-fair']) {
		const m24 = load(id, 'pres-2024');
		const r24 = m24.regions.filter((r) => r.demShare !== null);
		const t24 = S.tally(r24, S.buildContext(r24, core, 0, {}));
		console.log(`${id} 2024: D ${t24.seats.D} R ${t24.seats.R} (${m24.regions.length - r24.length} without data)`);
		const map = load(id, 'pres-2020');
		const rs = map.regions.filter((r) => r.demShare !== null);
		assert.ok(map.regions.every((r) => geoArea(r.feature) < 2 * Math.PI), 'winding');
		const p = geoPath(geoAlbersUsa());
		assert.equal(map.regions.filter((r) => !p(r.feature)).length, 0, 'all project');

		// 1. two-party: identical to the plain margin model at several swings
		for (const sw of [-7, 0, 4.5]) {
			const ctx = S.buildContext(rs, core, sw, {});
			const t = S.tally(rs, ctx);
			const expectD = rs.filter((r) => S.margin(r.demShare, sw) > 0).length;
			assert.equal(t.seats.D, expectD, `two-party D seats @${sw}`);
			for (const r of rs) {
				const o = S.outcome(r, ctx);
				assert.equal(o.level, S.levelFromMargin(S.margin(r.demShare, sw)), 'level');
			}
		}
		const t0 = S.tally(rs, S.buildContext(rs, core, 0, {}));
		assert.equal(t0.seats.D, expect2020[id], '2020 D seats unchanged by refactor');

		// 2. multiparty: shares hit targets, sum to 1, regional party stays regional
		const parties = P.presetParties(core);
		const ctx = S.buildContext(rs, parties, 0, {});
		let v = 0; const acc = {}; let vTX = 0, accTX = 0;
		for (const r of rs) {
			const sh = S.shares(r, ctx);
			near(Object.values(sh).reduce((a, b) => a + b, 0), 1, 1e-9, 'shares sum');
			assert.ok(Object.values(sh).every((x) => x >= 0), 'non-negative');
			if (r.group !== 'TX') assert.equal(sh.p4 ?? 0, 0, 'regional party outside TX');
			else { vTX += r.votes; accTX += r.votes * sh.p4; }
			v += r.votes;
			for (const [k, x] of Object.entries(sh)) acc[k] = (acc[k] ?? 0) + r.votes * x;
		}
		for (const q of parties.filter((q) => !q.core && !q.states.length)) near(acc[q.id] / v, q.share / 100, 1e-6, `${q.name} national share`);
		near(accTX / vTX, 0.22, 1e-6, 'Lone Star TX share');
		const tm = S.tally(rs, ctx);
		console.log(`${id}: two-party D ${t0.seats.D} R ${t0.seats.R} | preset: ` +
			Object.entries(tm.seats).map(([k, n]) => `${parties.find((q) => q.id === k).name} ${n}`).join(', '));

		// 3. overrides: party override for an inactive party is ignored
		const r0 = rs[0];
		assert.equal(S.outcome(r0, S.buildContext(rs, core, 0, { [r0.id]: { p: 'p2', l: 4 } })).manual, false);
		assert.equal(S.outcome(r0, S.buildContext(rs, parties, 0, { [r0.id]: { p: 'p2', l: 4 } })).winner, 'p2');
	}

	// 4. untrusted party configs
	assert.equal(P.sanitizeParties([{ id: 'D' }]), null, 'needs D and R');
	assert.equal(P.sanitizeParties([...P.coreParties(), { id: '<img>', name: 'x' }]), null, 'bad id');
	const s = P.sanitizeParties([...P.coreParties(), { id: 'p1', name: 'x'.repeat(99), color: 'red;background:url(x)', share: 999, fromD: -5, states: ['TX', '"><script>'] }]);
	assert.equal(s[2].color, '#888888'); assert.equal(s[2].name.length, 40); assert.equal(s[2].share, 60);
	assert.equal(s[2].fromD, 0); assert.deepEqual(s[2].states, ['TX']);

	// 5. import path
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
