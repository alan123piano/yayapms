<script lang="ts">
	import { fmtMargin } from './format';
	import { margin, rankParties, type Tally } from './sim';
	import type { Party, StateReport } from './types';

	interface Props {
		group: string;
		tally: Tally;
		parties: Party[];
		report?: StateReport;
		onback: () => void;
	}
	let { group, tally, parties, report, onback }: Props = $props();

	let d = $derived(parties.find((p) => p.id === 'D'));
	let hist = $derived(report?.ensemble?.dem_seats_2020);
	let histMax = $derived(hist ? Math.max(...Object.values(hist)) : 1);
</script>

<h3>{group}</h3>
<p>
	{rankParties(tally, parties).filter((x) => x.n).map((x) => `${x.n} ${x.p.name}`).join(' · ')} of {tally.total}
</p>
{#if report?.ensemble && hist}
	<p class="muted small">
		ReCom ensemble ({report.ensemble.samples} plans), {d?.name} seats at the 2020 baseline (two-party):
	</p>
	<div class="hist">
		{#each Object.entries(hist) as [seats, n] (seats)}
			<div class:chosen={Number(seats) === report.chosen?.dem_seats_2020}>
				<span style:height="{(n / histMax) * 48}px" style:background={d?.color}></span>
				<small>{seats}</small>
			</div>
		{/each}
	</div>
	<p class="muted small">
		Outlined bar = this map's plan. Statewide 2020: {fmtMargin(margin(report.statewide_dem_share_2020 ?? 0.5, 0))}.
	</p>
{/if}
<button type="button" class="link" onclick={onback}>back to national</button>

<style>
	.hist {
		display: flex;
		align-items: flex-end;
		gap: 4px;
		height: 66px;
	}
	.hist div {
		display: flex;
		flex-direction: column;
		align-items: center;
		flex: 1;
		max-width: 36px;
	}
	.hist span {
		width: 100%;
		border-radius: 2px 2px 0 0;
		opacity: 0.55;
	}
	.hist .chosen span {
		opacity: 1;
		outline: 2px solid var(--fg);
	}
</style>
