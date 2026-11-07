<script lang="ts">
	import { fmtMargin } from './format';
	import { spectrumOrder } from './parties';
	import type { Basis, Scenario } from './model';
	import { buildContext, tally, tippingSwing, type SeatSystem } from './sim';
	import type { LoadedMap, Override } from './types';

	interface Props {
		/** all loaded maps, with results for the selected election */
		maps: Record<string, LoadedMap>;
		/** fitted vote model per map */
		bases: Record<string, Basis>;
		currentId: string;
		scenario: Scenario;
		overrides: Record<string, Record<string, Override>>;
		seatSystem: SeatSystem;
	}
	let { maps, bases, currentId, scenario, overrides, seatSystem }: Props = $props();
	let parties = $derived(scenario.parties);

	let twoParty = $derived(parties.length === 2);
	/** the tipping swing is a district (FPTP) measure */
	let showTip = $derived(twoParty && seatSystem.kind === 'fptp');
	let dName = $derived(parties.find((p) => p.id === 'D')?.name);

	// Same scenario on every map, limited to states present in the current map
	// so a partially covered map compares like-for-like.
	let rows = $derived.by(() => {
		const cur = maps[currentId];
		if (!cur) return [];
		const scope = new Set(cur.regions.filter((r) => r.demShare !== null).map((r) => r.group));
		return Object.values(maps)
			.filter((m) => m.regions.some((r) => r.demShare !== null))
			.map((m) => {
				const rs = m.regions.filter((r) => scope.has(r.group));
				const c = buildContext(bases[m.manifest.id], rs, scenario, overrides[m.manifest.id] ?? {});
				return { id: m.manifest.id, name: m.manifest.name, t: tally(rs, c, seatSystem), tip: showTip ? tippingSwing(rs, c) : null };
			});
	});
	let cols = $derived(spectrumOrder(parties).filter((p) => p.core || rows.some((r) => r.t.seats[p.id])));
</script>

{#if rows.length > 1}
	<h3>Compare maps</h3>
	<table>
		<thead>
			<tr>
				<th>Map</th>
				{#each cols as p (p.id)}<th title={p.name}><span class="swatch sm" style:background={p.color}></span></th>{/each}
				{#if showTip}<th title="Uniform swing needed for a {dName} majority">Tipping</th>{/if}
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row.id)}
				<tr class:current={row.id === currentId}>
					<td>{row.name}</td>
					{#each cols as p (p.id)}<td>{row.t.seats[p.id] ?? 0}</td>{/each}
					{#if showTip}<td>{row.tip === null ? '—' : fmtMargin(row.tip)}</td>{/if}
				</tr>
			{/each}
		</tbody>
	</table>
	<p class="muted small">
		Same swing and parties on every map, limited to states in the current map.{#if showTip}
			Tipping = D/R swing at which {dName}s win a majority.{/if}
	</p>
{/if}

<style>
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	th,
	td {
		text-align: left;
		padding: 4px 6px;
		border-bottom: 1px solid var(--border);
	}
	td:not(:first-child),
	th:not(:first-child) {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	tr.current td {
		font-weight: 600;
	}
</style>
