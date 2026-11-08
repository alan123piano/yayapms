<script lang="ts">
	import { spectrumOrder } from './parties';
	import { majorityStatus, type Tally } from './sim';
	import type { Party } from './types';

	interface Props {
		tally: Tally;
		/** national vote share per party (0..1): the list vote under MMP */
		vote: Record<string, number>;
		/** total votes cast */
		votes: number;
		/** the baseline election (no edits): seats and vote share, for the changes */
		before: { tally: Tally; vote: Record<string, number> } | null;
		/** short baseline name, e.g. "2026 House" */
		baselineLabel: string;
		parties: Party[];
	}
	let { tally: t, vote, votes, before, baselineLabel, parties }: Props = $props();

	let majority = $derived(Math.floor(t.total / 2) + 1);
	/** parties on the ballot, most seats first, then most votes */
	let rows = $derived(
		parties
			.map((p) => ({ p, seats: t.seats[p.id] ?? 0, vote: vote[p.id] ?? 0 }))
			.filter((x) => x.seats > 0 || x.vote >= 0.0005)
			.sort((a, b) => b.seats - a.seats || b.vote - a.vote)
	);
	/** a baseline party's change; added parties are new */
	const isNew = (p: Party) => !before || !(p.id in before.vote);
	const signed = (x: number, digits = 0) => {
		const v = x.toFixed(digits);
		return Number(v) === 0 ? '±0' : `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(digits)}`;
	};
	const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
	const big = (n: number) =>
		n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
	let unders = $derived(t.mmp ? rows.filter((x) => !t.mmp!.eligible.includes(x.p.id)) : []);
</script>

<div class="seatbar" role="img" aria-label={rows.map((x) => `${x.seats} ${x.p.name}`).join(', ')}>
	{#each spectrumOrder(parties) as p (p.id)}
		<div style:flex-grow={t.seats[p.id] ?? 0} style:background={p.color}></div>
	{/each}
	<div style:flex-grow={t.unrated} style:background="var(--unrated)"></div>
	<span class="majority" style:left="{(majority / t.total) * 100}%"></span>
</div>
<p class="status">{majorityStatus(t, parties)}</p>

<table>
	<thead>
		<tr>
			<th class="party">Party</th>
			<th>Seats</th>
			<th title="Change from {baselineLabel}">±</th>
			<th>{t.mmp ? 'List vote' : 'Vote'}</th>
			<th title="Change from {baselineLabel}, in points">±</th>
		</tr>
	</thead>
	<tbody>
		{#each rows as { p, seats, vote: v } (p.id)}
			<tr>
				<td class="party"><span class="swatch" style:background={p.color}></span><span class="name">{p.name}</span></td>
				<td class="num seats" title={t.mmp ? `${t.mmp.districts[p.id] ?? 0} districts + ${t.mmp.list[p.id] ?? 0} list` : undefined}>{seats}</td>
				<td class="num delta">{isNew(p) ? 'new' : signed(seats - (before!.tally.seats[p.id] ?? 0))}</td>
				<td class="num">{pct(v)}{#if t.mmp && !t.mmp.eligible.includes(p.id)}<sup>*</sup>{/if}</td>
				<td class="num delta">{isNew(p) ? 'new' : signed((v - before!.vote[p.id]) * 100, 1)}</td>
			</tr>
		{/each}
		{#if t.unrated}
			<tr title="No result for this election">
				<td class="party"><span class="swatch" style:background="var(--unrated)"></span><span class="name">No result</span></td>
				<td class="num seats">{t.unrated}</td><td></td><td></td><td></td>
			</tr>
		{/if}
	</tbody>
	<tfoot>
		<tr><td class="party">Total</td><td class="num">{t.total}</td><td></td><td class="num">{big(votes)}</td><td></td></tr>
	</tfoot>
</table>
<p class="muted small">
	{majority} for a majority · changes from {baselineLabel}{#if t.mmp} · seats are districts + list{#if t.mmp.extra > 0}, incl. {t.mmp.extra} overhang/levelling{/if}{/if}{#if unders.length} · * under the threshold{/if}
</p>

<style>
	.seatbar {
		position: relative;
		display: flex;
		height: 22px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--unrated);
	}
	.seatbar div {
		flex-basis: 0;
	}
	.majority {
		position: absolute;
		top: -2px;
		bottom: -2px;
		width: 2px;
		background: var(--fg);
		transform: translateX(-1px);
	}
	.status {
		font-weight: 600;
		margin: 8px 0 4px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		table-layout: fixed;
	}
	th {
		font-weight: 500;
		font-size: 0.75rem;
		color: var(--muted);
		text-align: right;
		padding: 2px 0 4px 6px;
		border-bottom: 1px solid var(--border);
		width: 3.2em;
	}
	th.party {
		text-align: left;
		width: auto;
		padding-left: 0;
	}
	th:nth-child(4) {
		width: 4.2em;
	}
	td {
		padding: 3px 0 3px 6px;
	}
	td.party {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-left: 0;
		min-width: 0;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.seats {
		font-weight: 700;
		font-size: 1.05rem;
	}
	.delta {
		color: var(--muted);
		font-size: 0.8rem;
	}
	tfoot td {
		border-top: 1px solid var(--border);
		color: var(--muted);
		padding-top: 5px;
	}
	sup {
		color: var(--muted);
	}
	p.small {
		margin: 4px 0 0;
	}
</style>
