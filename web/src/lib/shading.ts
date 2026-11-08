import {
	GRADIENT_FULL_AT, GRADIENT_MIN_STRENGTH, RESIDUAL_FULL_AT, TIER_STRENGTH, type ShadingId
} from './config';
import { RATING_NAMES, type Outcome, type Party } from './types';

/** Color strength (%) of a result's party color under a shading mode. */
export function strength(o: Outcome, mode: ShadingId): number {
	if (mode === 'solid') return 100;
	if (mode === 'tiers' || mode === 'residual') return TIER_STRENGTH[o.level];
	return GRADIENT_MIN_STRENGTH + (100 - GRADIENT_MIN_STRENGTH) * Math.min(1, Math.abs(o.margin ?? 0) / GRADIENT_FULL_AT);
}

/** CSS fill for a result: the winner's color faded toward --mix-base, or the unrated color. */
export function outcomeFill(o: Outcome, byId: Record<string, Party>, mode: ShadingId): string {
	if (o.unrated || o.winner === null) return 'var(--unrated)';
	const c = byId[o.winner]?.color ?? '#888888';
	return `color-mix(in oklab, ${c} ${strength(o, mode)}%, var(--mix-base))`;
}

/** "Lean Democratic", "Unrated", ... */
export function ratingText(o: Outcome, byId: Record<string, Party>): string {
	if (o.unrated || o.winner === null) return 'Unrated';
	return `${RATING_NAMES[o.level]} ${byId[o.winner]?.name ?? o.winner}`;
}

/** Unexplained mode: the color of the party the district backs most beyond what the model
 *  explains, stronger the bigger that gap (points of vote share). */
export function residualFill(gap: Record<string, number>, byId: Record<string, Party>): string {
	const [id, pts] = Object.entries(gap).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
	const c = byId[id]?.color ?? '#888888';
	const k = GRADIENT_MIN_STRENGTH + (100 - GRADIENT_MIN_STRENGTH) * Math.min(1, Math.max(0, pts) / RESIDUAL_FULL_AT);
	return `color-mix(in oklab, ${c} ${k}%, var(--mix-base))`;
}
