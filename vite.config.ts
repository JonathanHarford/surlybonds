import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [svelte()],
	build: {
		lib: {
			entry: '+page.svelte',
			formats: ['iife'],
			name: 'SurlyBonds',
		},
		rollupOptions: {
			output: {
				entryFileNames: 'surlybonds.iife.js',
			},
		},
		assetsInlineLimit: 10_000_000,
	},
});
