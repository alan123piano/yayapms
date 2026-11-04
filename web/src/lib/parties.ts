import type { Party } from './types';

export const MAX_PARTIES = 8;

export function coreParties(): Party[] {
	return [
		{ id: 'D', name: 'Democratic', color: '#2f6fdd', core: true, share: 0, fromD: 100, states: [] },
		{ id: 'R', name: 'Republican', color: '#d8333a', core: true, share: 0, fromD: 0, states: [] }
	];
}

/** A UK-flavoured four-party-plus-regional scenario to play with. */
export function presetParties(core: Party[]): Party[] {
	return [
		...core,
		{ id: 'p1', name: 'Progressive', color: '#2aa876', share: 11, fromD: 90, states: [] },
		{ id: 'p2', name: 'Forward', color: '#f2a900', share: 16, fromD: 50, states: [] },
		{ id: 'p3', name: 'America First', color: '#13a8c4', share: 13, fromD: 10, states: [] },
		{ id: 'p4', name: 'Lone Star', color: '#9c5b2e', share: 22, fromD: 35, states: ['TX'] }
	];
}

export const EXTRA_COLORS = ['#2aa876', '#f2a900', '#13a8c4', '#9c5b2e', '#8e44ad', '#e67e22', '#7f8c8d'];

export function nextPartyId(parties: Party[]): string {
	let n = 1;
	while (parties.some((p) => p.id === `p${n}`)) n++;
	return `p${n}`;
}

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^(D|R|p\d{1,3})$/;
const GROUP = /^[A-Za-z0-9 _.-]{1,40}$/;

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
		out.push({
			id,
			name: String(p.name ?? id).slice(0, 40) || id,
			color: typeof p.color === 'string' && HEX.test(p.color) ? p.color : '#888888',
			core: id === 'D' || id === 'R',
			share: id === 'D' || id === 'R' ? 0 : num(p.share, 0, 60),
			fromD: id === 'D' ? 100 : id === 'R' ? 0 : num(p.fromD, 0, 100),
			states: Array.isArray(p.states)
				? p.states.filter((s): s is string => typeof s === 'string' && GROUP.test(s)).slice(0, 60)
				: []
		});
	}
	if (!out.some((p) => p.id === 'D') || !out.some((p) => p.id === 'R')) return null;
	return out;
}

/** Order for seat bars: most-D-leaning first. */
export function spectrumOrder(parties: Party[]): Party[] {
	return [...parties].sort((a, b) => b.fromD - a.fromD);
}
