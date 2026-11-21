<script lang="ts">
	/**
	 * Wharf: a container ship at the wharf under a dockside crane. The top row of containers is
	 * unloaded onto the wharf one at a time, then loaded back (the animation runs forwards, then
	 * backwards). Still when `still`, or when motion is turned off; static/favicon.svg is the still frame.
	 */
	let { size = 28, still = false }: { size?: number; still?: boolean } = $props();
	// Gradient and clip ids must be unique per instance; the logo appears more than once on some pages.
	const id = $props.id();

	const W = 3.6;
	const H = 2.4;
	const BAYS = [7, 10.8, 14.6]; // stern to bow
	const TIERS = [18.6, 16.2, 13.8]; // bottom up; the top tier is the one that moves
	const FILLS = [
		['#ffffff', '#e6faf2', '#ffffff'],
		['#8fe3c4', '#bff3df', '#8fe3c4'],
		['#e6faf2', '#ffffff', '#e6faf2']
	];
	// Unload order: bow first. Each has its own keyframes (cycle0..2) below.
	const MOVING = [2, 1, 0];
</script>

{#snippet box(x: number, y: number, fill: string)}
	<rect x={x + 0.15} y={y + 0.15} width={W - 0.3} height={H - 0.3} rx="0.35" {fill} />
	<path d="M{x + W / 2} {y + 0.7}v{H - 1.4}" stroke="#132620" stroke-opacity="0.3" stroke-width="0.5" />
{/snippet}

<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" class="shrink-0">
	<defs>
		<linearGradient id="{id}-tile" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="#132620" />
			<stop offset="1" stop-color="#07120e" />
		</linearGradient>
		<clipPath id="{id}-inside"><rect x="1" y="1" width="30" height="30" rx="7" /></clipPath>
	</defs>
	<rect width="32" height="32" rx="8" fill="url(#{id}-tile)" />
	<rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#5dd0a9" stroke-opacity="0.25" />
	<g clip-path="url(#{id}-inside)">
		<!-- the wharf and its crane -->
		<path d="M19.6 25.6v6M23.2 25.6v6M26.8 25.6v6M30.4 25.6v6" stroke="#fff" stroke-opacity="0.4" stroke-width="1.3" />
		<rect x="18.8" y="24" width="18" height="1.8" rx="0.6" fill="#fff" />
		<path d="M29.4 24V5.4M29.4 5.6H5.4M29.4 8.6l-3.4-3" fill="none" stroke="#fff" stroke-opacity="0.75" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
		<path d="M27.6 24l1.8-3.4 1.8 3.4" fill="none" stroke="#fff" stroke-opacity="0.75" stroke-width="1.1" stroke-linejoin="round" />
		<!-- the ship: hull, bridge and funnel -->
		<path d="M1.4 21h17.2l1.2-1.4-1.9 6.6H4.2z" fill="#5dd0a9" />
		<path d="M2.4 23.2h16.2" stroke="#132620" stroke-opacity="0.35" stroke-width="0.6" />
		<path d="M2.2 21V11.6h4.2V21" fill="#bff3df" />
		<path d="M2.9 13.2h2.8M2.9 15.2h2.8" stroke="#132620" stroke-opacity="0.45" stroke-width="0.7" />
		<rect x="3.2" y="8.8" width="2.2" height="2.8" rx="0.4" fill="#5dd0a9" />
		<!-- cargo: two tiers stay, the top tier moves -->
		{#each BAYS as x, bay (bay)}
			{#each TIERS.slice(0, -1) as y, tier (tier)}
				{@render box(x, y, FILLS[bay][tier])}
			{/each}
		{/each}
		{#each MOVING as bay, i (bay)}
			<g class={still ? '' : `cycle${i}`}>{@render box(BAYS[bay], TIERS[2], FILLS[bay][2])}</g>
		{/each}
		<path class={still ? '' : 'tide'} d="M-4 27.4q2.5-1.6 5 0t5 0 5 0 5 0 5 0 5 0 5 0 5 0" fill="none" stroke="#5dd0a9" stroke-opacity="0.5" stroke-width="1.5" stroke-linecap="round" />
	</g>
</svg>

<style>
	/* Lift straight up, across under the crane, down onto the wharf stack (bottom up), then back. */
	.cycle0,
	.cycle1,
	.cycle2 {
		animation: 6.5s linear infinite alternate;
	}
	.cycle0 {
		animation-name: cycle0;
	}
	.cycle1 {
		animation-name: cycle1;
	}
	.cycle2 {
		animation-name: cycle2;
	}
	@keyframes cycle0 {
		0%, 6% { transform: translate(0, 0); animation-timing-function: cubic-bezier(0.45, 0, 0.4, 1); }
		12.72% { transform: translate(0, -6.4px); animation-timing-function: cubic-bezier(0.45, 0, 0.4, 1); }
		23.28% { transform: translate(8px, -6.4px); animation-timing-function: cubic-bezier(0.45, 0, 0.4, 1); }
		30%, 100% { transform: translate(8px, 7.8px); }
	}
	@keyframes cycle1 {
		0%, 34% { transform: translate(0, 0); animation-timing-function: cubic-bezier(0.45, 0, 0.4, 1); }
		40.72% { transform: translate(0, -6.4px); animation-timing-function: cubic-bezier(0.45, 0, 0.4, 1); }
		51.28% { transform: translate(11.8px, -6.4px); animation-timing-function: cubic-bezier(0.45, 0, 0.4, 1); }
		58%, 100% { transform: translate(11.8px, 5.4px); }
	}
	@keyframes cycle2 {
		0%, 62% { transform: translate(0, 0); animation-timing-function: cubic-bezier(0.45, 0, 0.4, 1); }
		68.72% { transform: translate(0, -6.4px); animation-timing-function: cubic-bezier(0.45, 0, 0.4, 1); }
		79.28% { transform: translate(15.6px, -6.4px); animation-timing-function: cubic-bezier(0.45, 0, 0.4, 1); }
		86%, 100% { transform: translate(15.6px, 3px); }
	}
	.tide {
		animation: tide 5s linear infinite;
	}
	@keyframes tide {
		to {
			transform: translateX(-10px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cycle0,
		.cycle1,
		.cycle2,
		.tide {
			animation: none;
		}
	}
</style>
