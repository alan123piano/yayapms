<script lang="ts">
	import { spectrumOrder } from './parties';
	import { majorityStatus, rankParties, type Tally } from './sim';
	import type { Party } from './types';

	interface Props {
		tally: Tally;
		parties: Party[];
	}
	let { tally: t, parties }: Props = $props();

	let ranked = $derived(rankParties(t, parties));
	let majority = $derived(Math.floor(t.total / 2) + 1);
	let rColor = $derived(parties.find((p) => p.id === 'R')?.color);
</script>

<div class="seatbar" role="img" aria-label={ranked.map((x) => `${x.n} ${x.p.name}`).join(', ')}>
	{#each spectrumOrder(parties) as p (p.id)}
		{#if p.id !== 'R'}<div style:flex-grow={t.seats[p.id] ?? 0} style:background={p.color}></div>{/if}
	{/each}
	<div style:flex-grow={t.unrated} style:background="var(--unrated)"></div>
	<div style:flex-grow={t.seats.R ?? 0} style:background={rColor}></div>
	<span class="majority" style:left="{(majority / t.total) * 100}%"></span>
</div>
<p class="status">{majorityStatus(t, parties)}</p>
<ul>
	{#each ranked as { p, n } (p.id)}
		<li>
			<span class="swatch" style:background={p.color}></span>{p.name}
			{#if t.mmp}
				<span class="muted small split" title="districts + list seats; national vote">
					{t.mmp.districts[p.id] ?? 0} + {t.mmp.list[p.id] ?? 0} · {((t.mmp.vote[p.id] ?? 0) * 100).toFixed(1)}%{#if !t.mmp.eligible.includes(p.id)} · under threshold{/if}
				</span>
			{/if}
			<b>{n}</b>
		</li>
	{/each}
	{#if t.unrated}
		<li title="No result for this election and no manual rating">
			<span class="swatch" style:background="var(--unrated)"></span>Unrated<b>{t.unrated}</b>
		</li>
	{/if}
	<li class="total">Total<b>{t.total}</b></li>
</ul>
<p class="muted small">
	{majority} for a majority{#if t.mmp} · districts + list seats{#if t.mmp.extra > 0}; {t.mmp.extra} overhang/levelling seats{/if}{/if}
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
	.split {
		margin-left: auto;
		margin-right: 8px;
	}
	.split + b {
		margin-left: 0;
		font-variant-numeric: tabular-nums;
	}
	.status {
		font-weight: 600;
		margin: 8px 0 4px;
	}
	ul {
		list-style: none;
		padding: 0;
		margin: 0 0 4px;
	}
	li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 3px 0;
	}
	li.total {
		border-top: 1px solid var(--border);
		margin-top: 2px;
		padding-top: 5px;
		color: var(--muted);
	}
	b {
		margin-left: auto;
		font-size: 1.15rem;
		font-variant-numeric: tabular-nums;
	}
</style>
