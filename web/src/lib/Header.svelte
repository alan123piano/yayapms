<script lang="ts">
	import { BASELINE_VARIANTS, type BaselineVariant } from './model';
	import type { Election } from './types';

	interface Props {
		maps: { id: string; name: string }[];
		currentId: string;
		elections: Election[];
		election: string;
		/** which version of the election to start from (see model.ts) */
		variant: BaselineVariant;
		groups: string[];
		focusGroup: string | null;
		loading: boolean;
		onselectmap: (id: string) => void;
		onimport: () => void;
		/** rendered height, used to size the map */
		height?: number;
	}
	let {
		maps, currentId, elections, election = $bindable(), variant = $bindable(), groups, focusGroup = $bindable(),
		loading, onselectmap, onimport, height = $bindable()
	}: Props = $props();
</script>

<header bind:clientHeight={height}>
	<h1>yayapms</h1>
	<label class="pick">Districts
		<select value={currentId} onchange={(e) => onselectmap(e.currentTarget.value)}>
			{#each maps as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
		</select>
	</label>
	{#if elections.length}
		<label class="pick">Baseline
			<select
				value={variant === 'real' ? election : `${election}|${variant}`}
				onchange={(e) => {
					const [id, v] = e.currentTarget.value.split('|');
					election = id;
					variant = (v as BaselineVariant) || 'real';
				}}
			>
				{#each elections as e (e.id)}
					<option value={e.id}>{e.label}</option>
					{#if e.cells}
						{#each BASELINE_VARIANTS.filter((x) => x.id !== 'real') as x (x.id)}
							<option value="{e.id}|{x.id}" title={x.hint}>{e.label}, {x.label}</option>
						{/each}
					{/if}
				{/each}
			</select>
		</label>
	{/if}
	<select value={focusGroup ?? ''} onchange={(e) => (focusGroup = e.currentTarget.value || null)} aria-label="Jump to state">
		<option value="">Jump to state…</option>
		{#each groups as g (g)}<option value={g}>{g}</option>{/each}
	</select>
	<button type="button" onclick={onimport}>Import map…</button>
	{#if loading}<span class="muted">loading…</span>{/if}
</header>

<style>
	header {
		position: sticky;
		top: 0;
		z-index: 5; /* above the map, below the tooltip */
		background: var(--bg);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		padding: 8px 16px;
		border-bottom: 1px solid var(--border);
	}
	h1 {
		font-size: 1.15rem;
		margin: 0 8px 0 0;
		letter-spacing: -0.01em;
	}
	.pick {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.85rem;
		color: var(--muted);
	}
</style>
