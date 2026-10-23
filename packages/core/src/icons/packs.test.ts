import { afterEach, describe, expect, it } from 'vitest'
import { clearIconPacks, iconPackGeneration, iconPaint, iconSvg, lazyIconPack, listIconPacks, onIconPacksChange, parseVendorSvg, registerIconPack, resolveIcon, searchIcons, unregisterIconPack, type IconPack } from '.'
import { renderDiagramSvg } from '../render/svg'
import { layoutDiagram } from '../layout/layout'
import { parseOcto } from '../dsl/parse'

// Hand-written placeholder art: NOT vendor icons. Tests never touch the network or the real cache.
const SVG: Record<string, string> = {
	'aws-ec2': '<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg" width="80px" height="80px" viewBox="0 0 80 80"><title>t</title><g id="unused"><rect id="bg" width="80" height="80" fill="#ff8800"/><circle r="9" onclick="alert(1)"/></g><script>alert(1)</script></svg>',
	'aws-simple-storage-service': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 48 48"><defs><linearGradient id="g1"><stop offset="0" stop-color="#22aa22"/></linearGradient></defs><rect width="48" height="48" fill="url(#g1)"/><image xlink:href="https://example.com/x.png"/><use href="#g1"/></svg>',
	'gcp-cloud-run': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><style>.cls-1{fill:#4285f4;opacity:.5}.cls-2{fill:#aecbfa}</style></defs><path class="cls-1 cls-2" d="M2 2h10v20H2z"/></svg>',
	'azure-function-apps': '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><path d="M1 1h16v16H1z" fill="#0078d4"/></svg>',
}

const fake = (vendor: 'aws' | 'gcp' | 'azure', icons: string[], aliases: Record<string, string> = {}): IconPack => ({
	vendor,
	version: 'test',
	icons: Object.fromEntries(icons.map((n) => [n, { label: `Label ${n}`, file: `${n}.svg` }])),
	aliases,
	svg: (n) => SVG[n] ?? SVG['azure-function-apps'],
})

const registerAll = () => {
	registerIconPack(fake('aws', ['aws-ec2', 'aws-simple-storage-service', 'aws-only-in-pack'], { 'aws-s3': 'aws-simple-storage-service' }))
	registerIconPack(fake('gcp', ['gcp-cloud-run']))
	registerIconPack(fake('azure', ['azure-function-apps'], { 'azure-functions': 'azure-function-apps' }))
}

afterEach(() => clearIconPacks())

describe('icon packs', () => {
	it('falls back to the generic badge icons when no pack is registered', () => {
		const ec2 = resolveIcon('aws-ec2')!
		expect(ec2.source).toBe('lucide')
		expect(ec2.badge).toBe('EC2')
		expect(ec2.svg).toBeUndefined()
	})

	it('resolves vendor names to the official icon once a pack is registered', () => {
		registerAll()
		const ec2 = resolveIcon('aws-ec2')!
		expect(ec2).toMatchObject({ name: 'aws-ec2', source: 'pack', vendor: 'aws', viewBox: '0 0 80 80', monochrome: false, label: 'Label aws-ec2' })
		expect(ec2.badge).toBeUndefined()
		expect(ec2.svg).toContain('fill="#ff8800"')
		// catalog aliases, Eraser names and pack aliases all reach the pack
		expect(resolveIcon('ec2')?.source).toBe('pack')
		expect(resolveIcon('AWS_S3')).toMatchObject({ name: 'aws-s3', source: 'pack', pack: { name: 'aws-simple-storage-service', version: 'test' } })
		expect(resolveIcon('gcp-cloud-run')?.source).toBe('pack')
		expect(resolveIcon('azure-functions')?.source).toBe('pack')
		expect(resolveIcon('aws-only-in-pack')?.source).toBe('pack')
		// names the pack doesn't have keep the badge fallback
		expect(resolveIcon('aws-lambda')?.source).toBe('lucide')
		expect(resolveIcon('kafka')?.source).toBe('simple-icons')
		expect(listIconPacks().map((p) => p.vendor).sort()).toEqual(['aws', 'azure', 'gcp'])
	})

	it('unregistering restores the fallback', () => {
		registerAll()
		unregisterIconPack('aws')
		expect(resolveIcon('aws-ec2')?.source).toBe('lucide')
		expect(resolveIcon('gcp-cloud-run')?.source).toBe('pack')
	})

	it('keeps vendor colors; grayscale is opt-in', () => {
		registerAll()
		const run = resolveIcon('gcp-cloud-run')!
		expect(iconPaint(run, '#000')).toEqual({})
		const color = iconSvg(run, { color: '#111111' })
		expect(color).not.toContain('#111111')
		expect(color).not.toContain('feColorMatrix')
		const gray = iconSvg(run, { grayscale: true })
		expect(gray).toContain('<feColorMatrix type="saturate" values="0"/>')
		expect(gray).toMatch(/<g filter="url\(#od-gray-gcp-cloud-run\)">/)
	})

	it('searches pack-only names', () => {
		registerAll()
		expect(searchIcons('aws only').map((h) => h.name)).toContain('aws-only-in-pack')
	})

	it('lazy packs fall back until the SVG arrives, then notify', async () => {
		let resolveFetch!: (s: string) => void
		const pack = lazyIconPack(fake('aws', ['aws-ec2']), () => new Promise<string>((r) => (resolveFetch = r)))
		registerIconPack(pack)
		let notified = 0
		const off = onIconPacksChange(() => notified++)
		const gen = iconPackGeneration()
		expect(resolveIcon('aws-ec2')?.source).toBe('lucide')
		resolveFetch(SVG['aws-ec2'])
		await new Promise((r) => setTimeout(r, 0))
		expect(notified).toBe(1)
		expect(iconPackGeneration()).toBeGreaterThan(gen)
		expect(resolveIcon('aws-ec2')?.source).toBe('pack')
		off()
	})
})

describe('parseVendorSvg', () => {
	it('strips active content and external references', () => {
		const v = parseVendorSvg(SVG['aws-ec2'], 'p-')!
		expect(v.viewBox).toBe('0 0 80 80')
		expect(v.body).not.toMatch(/script|onclick|<title|<!--|<\?xml|id="unused"|id="bg"/)
		const s3 = parseVendorSvg(SVG['aws-simple-storage-service'], 'p-')!
		expect(s3.body).not.toContain('example.com')
		expect(s3.body).toContain('id="p-g1"')
		expect(s3.body).toContain('fill="url(#p-g1)"')
		expect(s3.body).toContain('href="#p-g1"')
	})

	it('scopes CSS classes and derives a viewBox from width/height', () => {
		const run = parseVendorSvg(SVG['gcp-cloud-run'], 'od-x-')!
		expect(run.body).toContain('.od-x-cls-1{fill:#4285f4;opacity:.5}')
		expect(run.body).toContain('class="od-x-cls-1 od-x-cls-2"')
		expect(parseVendorSvg(SVG['azure-function-apps'], 'p-')!.viewBox).toBe('0 0 18 18')
		expect(parseVendorSvg('<div/>', 'p-')).toBeNull()
	})
})

describe('headless render', () => {
	it('embeds official icons in color, or grayscale on request', async () => {
		registerAll()
		const { ir } = parseOcto('Web [icon: gcp-cloud-run]\nFn [icon: aws-lambda]\nWeb > Fn\n')
		const layout = await layoutDiagram(ir)
		const svg = renderDiagramSvg(ir, layout)
		expect(svg).toMatch(/<svg x="[\d.]+" y="[\d.]+" width="\d+" height="\d+" viewBox="0 0 24 24" overflow="visible" data-icon="gcp-cloud-run">/)
		expect(svg).toContain('.od-gcp-gcp-cloud-run-cls-1')
		// aws-lambda isn't in the fake pack: generic glyph + badge
		expect(svg).toMatch(/data-icon="aws-lambda"[^>]*>[\s\S]*?>λ<\/text>/)
		const gray = renderDiagramSvg(ir, layout, { officialIcons: 'grayscale' })
		expect(gray).toContain('feColorMatrix')
	})
})
