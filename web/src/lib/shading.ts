import {
	GRADIENT_FULL_AT, GRADIENT_MIN_STRENGTH, RESIDUAL_FULL_AT, TIER_STRENGTH, TIER_TYPICAL_MARGIN, type ShadingId
} from './config';
import { RATING_NAMES, type Outcome, type Party } from './types';

/** Color strength (%) of a result's party color under a shading mode. */
export function strength(o: Outcome, mode: ShadingId): number {
	if (mode === 'solid') return 100;
	if (mode === 'tiers' || mode === 'residual') return TIER_STRENGTH[o.level];
	const m = o.margin ?? TIER_TYPICAL_MARGIN[o.level];
	return GRADIENT_MIN_STRENGTH + (100 - GRADIENT_MIN_STRENGTH) * Math.min(1, Math.abs(m) / GRADIENT_FULL_AT);
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

/** Residual mode: D color for districts more D than their demographics, R color for more R. */
export function residualFill(points: number, byId: Record<string, Party>): string {
	const c = (points >= 0 ? byId.D?.color : byId.R?.color) ?? '#888888';
	const k = GRADIENT_MIN_STRENGTH + (100 - GRADIENT_MIN_STRENGTH) * Math.min(1, Math.abs(points) / RESIDUAL_FULL_AT);
	return `color-mix(in oklab, ${c} ${k}%, var(--mix-base))`;
}
