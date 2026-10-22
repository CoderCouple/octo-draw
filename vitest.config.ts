import { defineConfig } from 'vitest/config'

/** One test run across the monorepo: `pnpm test` at the root. Each package keeps its own defaults/config. */
export default defineConfig({
	test: {
		projects: ['packages/*', 'apps/*'],
		passWithNoTests: true,
	},
})
