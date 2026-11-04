/** Signed two-party margin in points as "D+4.5" / "R+2.0" / "Even". */
export function fmtMargin(m: number, digits = 1): string {
	return m === 0 ? 'Even' : `${m > 0 ? 'D' : 'R'}+${Math.abs(m).toFixed(digits)}`;
}

/** Short swing label for slider ticks: "0", "D+5", "R+20". */
export function swingLabel(s: number): string {
	return s === 0 ? '0' : `${s > 0 ? 'D' : 'R'}+${Math.abs(s)}`;
}
