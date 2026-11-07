import { DEFAULT_PARTIES, EXAMPLE_PARTIES, KNOWN_PARTIES, MAX_APPEALS, MAX_PARTIES, NEW_PARTY_COLORS } from './config';
import type { Party } from './types';

export function coreParties(): Party[] {
	return structuredClone(DEFAULT_PARTIES);
}

/** the user's D/R plus the example extra parties */
export function presetParties(core: Party[]): Party[] {
	return [...core, ...structuredClone(EXAMPLE_PARTIES)];
}

export function nextPartyId(parties: Party[]): string {
	let n = 1;
	while (parties.some((p) => p.id === `p${n}`)) n++;
	return `p${n}`;
}

const HEX = /^#[0-9a-f]{6}$/i;
/** a party of the election's data (e.g. \"D\", \"R\") or an added one (\"p1\", ...) */
const ID = /^([A-Z][A-Za-z0-9]{0,7}|p\d{1,3})$/;
const ADDED = /^p\d{1,3}$/;
const GROUP = /^[A-Za-z0-9 _.-]{1,40}$/;

const AUD = /^[A-Za-z0-9 +\-]{1,30}$/;
/** Shape-check an untrusted voter-group filter ({dim: [groups]}; {} = everyone); unknown groups simply match nobody. */
function filter(raw: unknown): Record<string, string[]> | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const out: Record<string, string[]> = {};
	for (const [dim, groups] of Object.entries(raw as Record<string, unknown>).slice(0, 10)) {
		if (!AUD.test(dim) || !Array.isArray(groups)) return undefined;
		const gs = groups.filter((g): g is string => typeof g === 'string' && AUD.test(g)).slice(0, 10);
		if (gs.length) out[dim] = gs;
	}
	return out;
}

/** Validate untrusted party config (URL hash / localStorage). Returns null if unusable. */
export function sanitizeParties(raw: unknown): Party[] | null {
	if (!Array.isArray(raw) || !raw.length || raw.length > MAX_PARTIES) return null;
	const out: Party[] = [];
	for (const x of raw) {
		if (!x || typeof x !== 'object') return null;
		const p = x as Record<string, unknown>;
		const id = String(p.id ?? '');
		if (!ID.test(id) || out.some((q) => q.id === id)) return null;
		const num = (v: unknown, lo: number, hi: number) =>
			typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
		const appeals: Party['appeals'] = [];
		for (const a of Array.isArray(p.appeals) ? p.appeals.slice(0, MAX_APPEALS) : []) {
			const x = (a ?? {}) as Record<string, unknown>;
			const f = filter(x.filter);
			if (!f) continue;
			if (typeof x.points === 'number') appeals.push({ filter: f, points: num(x.points, -100, 100) });
			// older links: a share target, fitted to points once the map loads
			else if (typeof x.share === 'number') appeals.push({ filter: f, points: 0, target: num(x.share, 0, 100) });
		}
		// oldest links: one `audience` group, won at `share`%, and nothing elsewhere
		const legacy = filter(p.audience);
		if (legacy && Object.keys(legacy).length && !appeals.length) appeals.push({ filter: legacy, points: 0, target: num(p.share, 0, 100) });
		const core = !ADDED.test(id);
		const pulls: Record<string, number> = {};
		if (p.pulls && typeof p.pulls === 'object' && !Array.isArray(p.pulls)) {
			for (const [k, v] of Object.entries(p.pulls as Record<string, unknown>).slice(0, MAX_PARTIES)) {
				if (ID.test(k) && !ADDED.test(k)) pulls[k] = num(v, 0, 100);
			}
		} else if (typeof p.fromD === 'number') {
			// older links: one D-vs-R slider
			pulls.D = num(p.fromD, 0, 100);
			pulls.R = 100 - pulls.D;
		}
		out.push({
			id,
			name: String(p.name ?? id).slice(0, 40) || id,
			color: typeof p.color === 'string' && HEX.test(p.color) ? p.color : '#888888',
			core,
			share: core || (legacy && Object.keys(legacy).length) ? 0 : num(p.share, 0, 60),
			...(core || !Object.keys(pulls).length ? {} : { pulls }),
			states: Array.isArray(p.states)
				? p.states.filter((s): s is string => typeof s === 'string' && GROUP.test(s)).slice(0, 60)
				: [],
			appeals
		});
	}
	return out;
}

/**
 * Display order (seat bars, tables): the election's parties in their data order, and each added
 * party at the weighted average position of the parties it pulls from, so a party drawing
 * mostly from the first sits next to it.
 */
export function spectrumOrder(parties: Party[]): Party[] {
	const base = parties.filter((p) => p.core);
	const pos = (p: Party) => {
		const i = base.indexOf(p);
		if (i >= 0) return i;
		const w = base.map((b) => Math.max(0, p.pulls?.[b.id] ?? 50));
		const W = w.reduce((a, x) => a + x, 0);
		return W ? w.reduce((a, x, k) => a + x * k, 0) / W : (base.length - 1) / 2;
	};
	return parties.map((p, i) => ({ p, at: pos(p), i })).sort((a, b) => a.at - b.at || a.i - b.i).map((x) => x.p);
}

/**
 * The parties list for an election: every party of its data (`ids`) present, in data order and
 * marked core (existing entries keep their settings; new ones take a known name/color), then
 * the added parties. Parties of other elections' data are kept, so switching back restores them.
 */
export function withElectionParties(parties: Party[], ids: string[], names: Record<string, string> = {}): Party[] {
	const known = new Map(KNOWN_PARTIES.map((p) => [p.id, p]));
	const have = new Map(parties.map((p) => [p.id, p]));
	const used = new Set(parties.map((p) => p.color));
	const data = ids.map((id) => {
		const p = have.get(id);
		if (p) return { ...p, core: true };
		const k = known.get(id);
		const color = k?.color ?? NEW_PARTY_COLORS.find((c) => !used.has(c)) ?? '#888888';
		used.add(color);
		return { id, name: names[id] ?? k?.name ?? id, color, core: true, share: 0, states: [], appeals: [] } as Party;
	});
	const rest = parties.filter((p) => !ids.includes(p.id));
	return [...data, ...rest];
}
