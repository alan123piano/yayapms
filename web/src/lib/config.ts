/**
 * Every adjustable setting in one place. Change behavior here; the rest of the code reads these.
 */
import type { Party } from './types';

// ---------- startup defaults ----------
/** paint brush selected at startup: a party id, or 'auto' (use the election baseline) */
export const DEFAULT_BRUSH = 'auto';
export const DEFAULT_SHADING: ShadingId = 'tiers';
/** election selected at startup when the map has it (otherwise its newest) */
export const DEFAULT_ELECTION = 'pres-2020';

// ---------- parties ----------
export const MAX_PARTIES = 8;
/** voter groups a party can have an appeal in (single groups + custom groups + everyone) */
export const MAX_APPEALS = 40;
export const DEFAULT_PARTIES: Party[] = [
	{ id: 'D', name: 'Democratic', color: '#2f6fdd', core: true, share: 0, fromD: 100, states: [], appeals: [] },
	{ id: 'R', name: 'Republican', color: '#d8333a', core: true, share: 0, fromD: 0, states: [], appeals: [] }
];
/** "Load example scenario": a UK-flavoured four-party-plus-regional setup */
export const EXAMPLE_PARTIES: Party[] = [
	{ id: 'p1', name: 'Progressive', color: '#2aa876', share: 11, fromD: 90, states: [], appeals: [] },
	{ id: 'p2', name: 'Forward', color: '#f2a900', share: 16, fromD: 50, states: [], appeals: [] },
	{ id: 'p3', name: 'America First', color: '#13a8c4', share: 13, fromD: 10, states: [], appeals: [] },
	{ id: 'p4', name: 'Lone Star', color: '#9c5b2e', share: 22, fromD: 35, states: ['TX'], appeals: [] }
];
/** colors offered to newly added parties, in order */
export const NEW_PARTY_COLORS = ['#2aa876', '#f2a900', '#13a8c4', '#9c5b2e', '#8e44ad', '#e67e22', '#7f8c8d'];

// ---------- ratings ----------
/** lead (points) where Tilt -> Lean -> Likely -> Safe */
export const RATING_THRESHOLDS = [3, 8, 15] as const;

// ---------- shading ----------
export const SHADINGS = [
	{ id: 'solid', label: 'Solid', hint: 'Full color for whoever wins' },
	{ id: 'tiers', label: 'Tiers', hint: 'Safe / Likely / Lean / Tilt: 15+, 8-15, 3-8, <3 point lead' },
	{ id: 'gradient', label: 'Gradient', hint: 'Fades smoothly toward a tie; full color at a 25+ point lead' },
	{ id: 'residual', label: 'Residual', hint: 'How much more D or R each district voted than its demographics predict; full color at 40+ points' }
] as const;
export type ShadingId = (typeof SHADINGS)[number]['id'];
/** color strength (%) per rating level [-, Tilt, Lean, Likely, Safe] in Tiers mode */
export const TIER_STRENGTH = [0, 28, 48, 72, 100];
/** Gradient mode: strength at a tie, and the lead (points) that reaches full color */
export const GRADIENT_MIN_STRENGTH = 12;
export const GRADIENT_FULL_AT = 25;
/** Residual mode: residual (margin points) that reaches full color */
export const RESIDUAL_FULL_AT = 40;
/** stand-in margin per level for hand-painted districts in Gradient mode */
export const TIER_TYPICAL_MARGIN = [0, 1.5, 5.5, 11.5, 20];

// ---------- swing slider ----------
/** discrete stops on each side of 0, evenly spaced on the bar */
export const SWING_STOPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 25, 30, 35, 40];
/** stops that get a clickable label under the bar */
export const SWING_LABELS = [-20, -10, -5, 0, 5, 10, 20];

// ---------- voter groups (demographic swings) ----------
/** slider limits: (older links') vote swing in margin points, turnout change in %, appeal in points */
export const DEMO_LIMITS = { vote: 30, turnout: 50, appeal: 50 };
/** tab names for the cell dimensions written by pipeline/cells.py */
export const DEMO_DIM_LABELS: Record<string, string> = { age: 'Age', race: 'Race', edu: 'Education', sex: 'Gender' };

// ---------- map view ----------
export const MAP_MAX_ZOOM = 40;
/** ms after the last pan/zoom event before the crisp redraw */
export const REDRAW_DELAY_MS = 50;
