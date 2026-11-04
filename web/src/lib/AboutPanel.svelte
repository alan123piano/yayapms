<script lang="ts">
	import type { Election } from './types';

	interface Props {
		mapDescription?: string;
		election?: Election;
	}
	let { mapDescription, election }: Props = $props();
</script>

{#if mapDescription}
	<h3>About this map</h3>
	<p class="muted small">{mapDescription}</p>
{/if}
{#if election}
	<h3>About this election</h3>
	<p class="muted small">
		{election.label}{election.candidates ? ` (${Object.values(election.candidates).join(' vs. ')})` : ''}.
		{election.source ?? ''}
	</p>
	{#if election.credit}<p class="small"><b>{election.credit}</b></p>{/if}
{/if}
