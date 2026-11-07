<script lang="ts">
	import Scrubber, { stepped } from './Scrubber.svelte';
	import { FPTP, type SeatSystem } from './sim';

	interface Props {
		system: SeatSystem;
	}
	let { system = $bindable() }: Props = $props();

	const MMP_DEFAULT: SeatSystem = { kind: 'mmp', listSeats: 100, threshold: 5, waiver: 1, overhang: 'level' };
	const LIST = stepped(0, 200, 10);
	const THRESHOLD = stepped(0, 10, 0.5);
	const WAIVER = stepped(0, 5, 1);
	let mmp = $derived(system.kind === 'mmp' ? system : null);
	function patch(p: Partial<Extract<SeatSystem, { kind: 'mmp' }>>) {
		if (system.kind === 'mmp') system = { ...system, ...p };
	}
</script>

<div class="systems" role="radiogroup" aria-label="Seat system">
	<span class="muted small">Seats</span>
	<button type="button" role="radio" aria-checked={system.kind === 'fptp'} class:active={system.kind === 'fptp'}
		title="First past the post: each district goes to whoever gets the most votes" onclick={() => (system = FPTP)}>FPTP</button>
	<button type="button" role="radio" aria-checked={system.kind === 'mmp'} class:active={system.kind === 'mmp'}
		title="Mixed-member proportional: districts by FPTP, plus list seats that make the house proportional"
		onclick={() => { if (system.kind !== 'mmp') system = MMP_DEFAULT; }}>MMP</button>
</div>
{#if mmp}
	<div class="opts">
		<label>
			<span>List seats <b>{mmp.listSeats}%</b> <span class="muted">of districts</span></span>
			<Scrubber value={mmp.listSeats} stops={LIST} labels={[0, 100, 200]} format={(x) => `${x}%`} onchange={(x) => patch({ listSeats: x })} />
		</label>
		<label>
			<span>Threshold <b>{mmp.threshold}%</b> <span class="muted">of the national vote</span></span>
			<Scrubber value={mmp.threshold} stops={THRESHOLD} ticks={THRESHOLD.filter((x) => Number.isInteger(x))} labels={[0, 5, 10]} format={(x) => `${x}%`} onchange={(x) => patch({ threshold: x })} />
		</label>
		<label>
			<span>…or win <b>{mmp.waiver ? `${mmp.waiver}+ district${mmp.waiver > 1 ? 's' : ''}` : 'no waiver'}</b></span>
			<Scrubber value={mmp.waiver} stops={WAIVER} labels={[0, 1, 3, 5]} format={(x) => (x ? String(x) : 'off')} onchange={(x) => patch({ waiver: x })} />
		</label>
		<div class="overhang" role="radiogroup" aria-label="Overhang seats">
			<span class="muted small" title="When a party wins more districts than its proportional share">Overhang</span>
			<button type="button" role="radio" aria-checked={mmp.overhang === 'level'} class:active={mmp.overhang === 'level'}
				title="Add levelling seats until every party is proportional again (Germany 2013-2023)" onclick={() => patch({ overhang: 'level' })}>Level</button>
			<button type="button" role="radio" aria-checked={mmp.overhang === 'keep'} class:active={mmp.overhang === 'keep'}
				title="The party keeps its extra districts; nobody else gets more (New Zealand)" onclick={() => patch({ overhang: 'keep' })}>Keep</button>
		</div>
		<p class="muted small">
			Districts are won by FPTP; list seats then top every party over the threshold up to its share
			of the national vote (Sainte-Laguë).
		</p>
	</div>
{/if}

<style>
	.systems,
	.overhang {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 10px;
	}
	.systems > span,
	.overhang > span {
		margin-right: 4px;
	}
	button {
		padding: 3px 10px;
		font-size: 0.85rem;
	}
	button.active {
		background: var(--fg);
		color: var(--bg);
		border-color: var(--fg);
	}
	.opts {
		border-left: 2px solid var(--border);
		padding-left: 8px;
		margin-top: 6px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: 8px;
		font-size: 0.85rem;
		color: var(--muted);
	}
	label b {
		color: var(--fg);
	}
	.opts p {
		margin: 8px 0 0;
	}
</style>
