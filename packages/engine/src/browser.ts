// Side effect: assigns window.__eraser (setup / registerFonts / run / serialize).
import '@eraserlabs/render/browser'
import type { RunResult } from '@eraserlabs/render/browser'
import { buildRenderPageSetup } from '@eraserlabs/diagram-templates'
import { buildFontsHead, type IconLoader, type ResolveResult } from '@eraserlabs/resolve'
import { mdpOnly, octoResolver } from './validate'
import type { MdpDoc } from './mdp'

/**
 * In-page Eraser render pipeline with octo's icons and our own fonts.
 *
 * `run()` always mounts `#eraser-scene` on `document.body` (a singleton, measured untransformed);
 * `renderMdp` then moves it into `host`, which may sit inside a CSS-transformed camera.
 */
export interface EraserFonts {
	/** URL of a variable Inter woff2 (OFL). Used for the `clean` role, and for `rough` (we ship no hand font). */
	inter: string
	/** Icon loader for the resolver; defaults to `octoIconLoader` (core catalog + registered packs). */
	iconLoader?: IconLoader
}

let ready: Promise<void> | undefined

export function setupEraser(fonts: EraserFonts): Promise<void> {
	ready ??= (async () => {
		const resolver = await octoResolver()
		window.__eraser.setup(buildRenderPageSetup(resolver.library))
		const config = {
			roles: { rough: 'Inter', clean: 'Inter', mono: 'ui-monospace' },
			fallbacks: { rough: 'sans-serif', clean: 'sans-serif', mono: 'monospace' },
			faces: [{ kind: 'url' as const, family: 'Inter', url: new URL(fonts.inter, location.href).href, format: 'woff2', weight: '100 900' }],
		}
		await window.__eraser.registerFonts({ css: buildFontsHead(config), faces: [], urlFaces: [{ family: 'Inter' }] })
	})()
	return ready
}

export interface RenderTimings {
	resolveMs: number
	runMs: number
	totalMs: number
}

export interface RenderOutcome {
	scene: HTMLElement
	resolved: ResolveResult
	result: RunResult
	timings: RenderTimings
}

let seq = 0

/** Resolve (validate, sanitize, inline icons) and render an MDP doc into `host`. */
export async function renderMdp(host: HTMLElement, doc: MdpDoc, fonts: EraserFonts): Promise<RenderOutcome | null> {
	const mine = ++seq
	await setupEraser(fonts)
	const t0 = performance.now()
	const resolved = await (await octoResolver(fonts.iconLoader)).resolve(mdpOnly(doc))
	const t1 = performance.now()
	if (!resolved.ok || !resolved.entities || !resolved.connections) {
		throw new Error(resolved.errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('\n') || 'resolve failed')
	}
	const result = await window.__eraser.run({ entities: resolved.entities, connections: resolved.connections, icons: resolved.icons ?? {} })
	const t2 = performance.now()
	if (mine !== seq) return null
	const scene = document.getElementById('eraser-scene')
	if (!scene) throw new Error('no #eraser-scene after run')
	host.replaceChildren(scene)
	return { scene, resolved, result, timings: { resolveMs: t1 - t0, runMs: t2 - t1, totalMs: t2 - t0 } }
}

/** Every rendered element's box in scene coordinates (what a selection overlay needs). */
export function elementBoxes(scene: HTMLElement): Record<string, { x: number; y: number; w: number; h: number; tag: string }> {
	const out: Record<string, { x: number; y: number; w: number; h: number; tag: string }> = {}
	for (const el of scene.querySelectorAll<HTMLElement>(':scope > [data-mdp-id]')) {
		out[el.dataset.mdpId!] = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, tag: el.dataset.mdpTag ?? '' }
	}
	return out
}
