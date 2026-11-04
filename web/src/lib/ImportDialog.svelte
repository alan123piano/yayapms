<script lang="ts">
	import type { FeatureCollection, Geometry } from 'geojson';
	import { buildMap, guessManifest, parseGeo, propertyNames } from './loader';
	import type { LoadedMap, MapManifest } from './types';

	interface Props {
		onload: (m: LoadedMap) => void;
		onclose: () => void;
	}
	let { onload, onclose }: Props = $props();

	let error = $state('');
	let fc = $state<FeatureCollection<Geometry> | null>(null);
	let fields = $state<string[]>([]);
	let m = $state<MapManifest | null>(null);
	let dem = $state('');
	let rep = $state('');
	let dialog: HTMLDialogElement;

	$effect(() => {
		dialog.showModal();
	});

	async function onfile(e: Event) {
		error = '';
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		try {
			fc = parseGeo(await file.text());
			fields = propertyNames(fc);
			const g = guessManifest(fc, file.name.replace(/\.(geo|topo)?json$/i, ''));
			m = g.manifest;
			dem = g.dem ?? '';
			rep = g.rep ?? '';
		} catch (err) {
			error = (err as Error).message;
			fc = null;
		}
	}

	function load() {
		if (!fc || !m) return;
		onload(buildMap($state.snapshot(m) as MapManifest, $state.snapshot(fc) as FeatureCollection<Geometry>, {
			voteProps: dem && rep ? { dem, rep } : undefined
		}));
	}
</script>

<dialog bind:this={dialog} onclose={onclose}>
	<h2>Import a map</h2>
	<p class="hint">
		GeoJSON or TopoJSON. Each feature is one clickable region. The file is read locally in your
		browser and never uploaded.
	</p>
	<input type="file" accept=".json,.geojson,.topojson,application/json" onchange={onfile} />
	{#if error}<p class="error">{error}</p>{/if}

	{#if fc && m}
		<p class="hint">{fc.features.length} features · {fields.length} properties</p>
		<div class="grid">
			<label>Name <input bind:value={m.name} /></label>
			<label>Projection
				<select bind:value={m.projection}>
					<option value="mercator">Mercator (lon/lat)</option>
					<option value="albersUsa">Albers USA (lon/lat, US only)</option>
					<option value="equalEarth">Equal Earth (lon/lat, world)</option>
					<option value="identity">Identity (already projected)</option>
				</select>
			</label>
			{#each [['ID', 'idProperty'], ['Label', 'labelProperty'], ['Group (e.g. state)', 'groupProperty'], ['Seats', 'seatsProperty']] as [lab, key] (key)}
				<label>{lab}
					<select bind:value={m[key as 'idProperty']}>
						<option value={undefined}>— none —</option>
						{#each fields as p (p)}<option value={p}>{p}</option>{/each}
					</select>
				</label>
			{/each}
			<label>Dem votes (optional)
				<select bind:value={dem}>
					<option value="">— none —</option>
					{#each fields as p (p)}<option value={p}>{p}</option>{/each}
				</select>
			</label>
			<label>Rep votes (optional)
				<select bind:value={rep}>
					<option value="">— none —</option>
					{#each fields as p (p)}<option value={p}>{p}</option>{/each}
				</select>
			</label>
		</div>
	{/if}

	<div class="actions">
		<button type="button" onclick={() => dialog.close()}>Cancel</button>
		<button type="button" class="primary" disabled={!fc} onclick={load}>Load map</button>
	</div>
</dialog>

<style>
	dialog {
		background: var(--surface);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 10px;
		width: min(560px, calc(100vw - 32px));
		padding: 20px;
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.45);
	}
	h2 {
		margin: 0 0 4px;
		font-size: 1.1rem;
	}
	.hint {
		color: var(--muted);
		font-size: 0.85rem;
		margin: 4px 0 12px;
	}
	.error {
		color: var(--danger);
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px 12px;
	}
	@media (max-width: 520px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
</style>
