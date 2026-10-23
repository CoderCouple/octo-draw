import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// core's icon catalog (~200 KB of brand paths) builds lookup tables at module
// load. Marking it side-effect free lets the main chunk drop it when only the
// dynamic import in lib/icons.ts uses it, so it ships as its own lazy chunk.
const PURE = /packages[\\/]core[\\/]src[\\/](icons[\\/]|render[\\/]iconAliases)/

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		proxy: {
			'/api': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
		},
	},
	build: {
		chunkSizeWarningLimit: 2000,
		rolldownOptions: {
			treeshake: { moduleSideEffects: (id: string) => !PURE.test(id) },
			output: { codeSplitting: { groups: [{ name: 'icon-catalog', test: PURE }] } },
		},
	},
})
