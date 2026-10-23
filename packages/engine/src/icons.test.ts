import { describe, expect, it } from 'vitest'
import { sanitizeSvg } from '@eraserlabs/resolve/svg-sanitize'
import { appendFileSync, existsSync } from 'node:fs'
import { clearIconPacks, registerIconPack } from '@octo-draw/core'
import { defaultIconsDir, iconPacksFromCache } from '@octo-draw/core/node/iconCache'
import { octoIconLoader } from './icons'

describe('octoIconLoader', () => {
	it('produces SVGs that pass Eraser’s sanitizer', async () => {
		for (const name of ['react~brand', 'react', 'postgres', 'server', 'aws-lambda', 'aws-s3', 'kafka', 'users']) {
			const svg = await octoIconLoader(name)
			const res = sanitizeSvg(svg)
			expect(res.ok, `${name}: ${JSON.stringify(res).slice(0, 300)}`).toBe(true)
		}
	})

	// The official AWS/GCP/Azure packs live in the user's icon cache (`pnpm icons:fetch`); this
	// checks how many of them survive Eraser's allowlist sanitizer when present.
	const dir = defaultIconsDir()
	it.runIf(existsSync(dir + '/manifest.json'))('official vendor packs pass the sanitizer', async () => {
		const packs = iconPacksFromCache(dir)
		for (const p of packs) registerIconPack(p)
		const failures: Record<string, number> = {}
		const elements: Record<string, number> = {}
		let total = 0
		let ok = 0
		try {
			for (const p of packs) {
				for (const name of Object.keys(p.icons)) {
					total++
					const res = sanitizeSvg(await octoIconLoader(name))
					if (res.ok) ok++
					else {
						failures[res.reason ?? '?'] = (failures[res.reason ?? '?'] ?? 0) + 1
						const tags = [...(await octoIconLoader(name)).matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1])
						for (const t of new Set(tags)) elements[t] = (elements[t] ?? 0) + 1
					}
				}
			}
		} finally {
			clearIconPacks()
		}
		if (process.env.BENCH_LOG) appendFileSync(process.env.BENCH_LOG, `vendor icons: ${ok}/${total} pass; failures ${JSON.stringify(failures)}; elements in failing icons ${JSON.stringify(elements)}\n`)
		expect(ok / total).toBeGreaterThan(0.99)
	}, 120_000)

	it('rejects unknown names', async () => {
		await expect(octoIconLoader('no-such-icon-xyz')).rejects.toThrow()
	})
})
