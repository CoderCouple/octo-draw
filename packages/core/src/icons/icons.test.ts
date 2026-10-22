import { describe, expect, it } from 'vitest'
import { CATALOG, ICON_ALL_NAMES, ICON_NAMES, iconColor, iconSvg, resolveIcon, searchIcons } from '.'
import { BRANDS } from './data/brands'
import { GLYPHS } from './data/glyphs'

describe('resolveIcon', () => {
	it('resolves Eraser-style names across vendors and brands', () => {
		for (const n of ['aws-ec2', 'aws-lambda', 'aws-s3', 'gcp-pubsub', 'gcp-bigquery', 'azure-functions', 'azure-cosmos-db', 'kafka', 'postgres', 'react', 'redis', 'docker', 'kubernetes', 'github', 'database', 'server', 'users']) {
			expect(resolveIcon(n), n).not.toBeNull()
		}
	})

	it('maps aliases to the canonical icon', () => {
		expect(resolveIcon('postgresql')?.name).toBe('postgres')
		expect(resolveIcon('k8s')?.name).toBe('kubernetes')
		expect(resolveIcon('lambda')?.name).toBe('aws-lambda')
		expect(resolveIcon('golang')?.name).toBe('go')
		expect(resolveIcon('azure-active-directory')?.name).toBe('azure-entra-id')
	})

	it('is case and separator insensitive', () => {
		expect(resolveIcon('  PostgreSQL ')?.name).toBe('postgres')
		expect(resolveIcon('AWS_EC2')?.name).toBe('aws-ec2')
		expect(resolveIcon('Next.js')?.name).toBe('nextjs')
	})

	it('describes brand logos as filled with a brand color, glyphs as monochrome strokes', () => {
		const pg = resolveIcon('postgres')!
		expect(pg).toMatchObject({ paint: 'fill', monochrome: false, brandColor: '#4169E1', source: 'simple-icons', label: 'PostgreSQL', viewBox: '0 0 24 24' })
		expect(pg.nodes[0][0]).toBe('path')
		const ec2 = resolveIcon('aws-ec2')!
		expect(ec2).toMatchObject({ paint: 'stroke', monochrome: true, badge: 'EC2', vendor: 'aws', source: 'lucide' })
		expect(ec2.brandColor).toBeUndefined()
		expect(ec2.nodes).toBe(GLYPHS.server)
	})

	it('falls back to glyph + badge for brands it cannot redistribute', () => {
		// vue's logo is CC-BY-NC-SA in simple-icons; slack isn't in simple-icons at all
		expect(resolveIcon('vue')).toMatchObject({ source: 'lucide', badge: 'VUEJS', monochrome: true })
		expect(resolveIcon('slack')).toMatchObject({ source: 'lucide', badge: 'SLACK' })
	})

	it('falls back to any vendored lucide glyph, the legacy alias table, and bare vendor names', () => {
		expect(resolveIcon('ship-wheel')?.source).toBe('lucide')
		expect(resolveIcon('sqs')?.name).toBe('aws-sqs')
		expect(resolveIcon('aws-cache')?.name).toBe('cache')
		expect(resolveIcon('nope-not-an-icon')).toBeNull()
		expect(resolveIcon('')).toBeNull()
		expect(resolveIcon(undefined)).toBeNull()
	})

	it('has data for every catalog entry and unique names', () => {
		for (const e of CATALOG) {
			const r = resolveIcon(e.name)!
			expect(r.name, e.name).toBe(e.name)
			expect(r.nodes.length, e.name).toBeGreaterThan(0)
		}
		expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length)
		expect(ICON_NAMES.length).toBeGreaterThan(150)
		expect(ICON_ALL_NAMES.length).toBeGreaterThan(ICON_NAMES.length)
		expect([...ICON_NAMES]).toEqual([...ICON_NAMES].sort())
	})

	it('only vendors brands with redistributable licenses', () => {
		for (const b of Object.values(BRANDS)) if (b.license) expect(['CC0-1.0', 'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC-BY-3.0', 'CC-BY-4.0']).toContain(b.license)
	})
})

describe('searchIcons', () => {
	it('ranks exact names, then aliases, then prefixes', () => {
		expect(searchIcons('kafka')[0].name).toBe('kafka')
		expect(searchIcons('postgresql')[0]).toMatchObject({ name: 'postgres', matched: 'postgresql' })
		const pg = searchIcons('postg').map((h) => h.name)
		expect(pg[0]).toBe('postgres')
		expect(searchIcons('k8s')[0].name).toBe('kubernetes')
	})

	it('matches vendor-prefixed and multi-word queries', () => {
		expect(searchIcons('aws lam')[0].name).toBe('aws-lambda')
		expect(searchIcons('aws-')[0].name.startsWith('aws-')).toBe(true)
		expect(searchIcons('cloud run')[0].name).toBe('gcp-cloud-run')
		expect(searchIcons('event hubs')[0].name).toBe('azure-event-hubs')
	})

	it('finds icons by tag and respects the limit', () => {
		const queues = searchIcons('queue', 50).map((h) => h.name)
		expect(queues[0]).toBe('queue')
		expect(queues).toContain('rabbitmq')
		expect(searchIcons('a', 5)).toHaveLength(5)
		expect(searchIcons('zzzzqqq')).toEqual([])
	})

	it('orders ties by name length, then alphabetically', () => {
		const hits = searchIcons('azure', 100)
		const sameScore = hits.filter((h) => h.score === hits[1].score)
		const lens = sameScore.map((h) => h.name.length)
		expect(lens).toEqual([...lens].sort((a, b) => a - b))
	})
})

describe('iconSvg / iconColor', () => {
	it('renders standalone svg in currentColor by default', () => {
		const svg = iconSvg(resolveIcon('kafka')!)
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"/)
		expect(svg).toContain('<path d="M')
	})

	it('uses the brand color only on request and when legible', () => {
		const gh = resolveIcon('github')!
		expect(iconColor(gh, '#111111')).toBe('#111111')
		expect(iconColor(gh, '#111111', { brand: true, background: '#ffffff' })).toBe('#181717')
		expect(iconColor(gh, '#eeeeee', { brand: true, background: '#0a0a0a' })).toBe('#eeeeee')
		expect(iconColor(resolveIcon('aws-ec2')!, '#111111', { brand: true })).toBe('#111111')
	})

	it('draws the badge pill', () => {
		const svg = iconSvg(resolveIcon('aws-ec2')!, { color: '#000000', size: 20 })
		expect(svg).toMatch(/<rect[^>]*rx="5" fill="#ffffff" stroke="#000000"[^>]*\/><text[^>]*>EC2<\/text><\/svg>$/)
	})
})
