import { DEFAULT_PARTIES, EXAMPLE_PARTIES, MAX_APPEALS, MAX_PARTIES } from './config';
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
const ID = /^(D|R|p\d{1,3})$/;
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
	if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_PARTIES) return null;
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
		const core = id === 'D' || id === 'R';
		out.push({
			id,
			name: String(p.name ?? id).slice(0, 40) || id,
			color: typeof p.color === 'string' && HEX.test(p.color) ? p.color : '#888888',
			core,
			share: core || (legacy && Object.keys(legacy).length) ? 0 : num(p.share, 0, 60),
			fromD: id === 'D' ? 100 : id === 'R' ? 0 : num(p.fromD, 0, 100),
			states: Array.isArray(p.states)
				? p.states.filter((s): s is string => typeof s === 'string' && GROUP.test(s)).slice(0, 60)
				: [],
			appeals
		});
	}
	if (!out.some((p) => p.id === 'D') || !out.some((p) => p.id === 'R')) return null;
	return out;
}

/** Order for seat bars: most-D-leaning first. */
export function spectrumOrder(parties: Party[]): Party[] {
	return [...parties].sort((a, b) => b.fromD - a.fromD);
}
