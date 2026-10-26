import { useEffect, useMemo, useRef, useState } from 'react'
import { layoutDiagram, lazyIconPack, onIconPacksChange, parseOctoPages, registerIconPack, resolveIcon, type DiagramIR, type DiagramLayout, type IconCacheManifest } from '@octo-draw/core'
import { irToMdp, layoutFromMdp, mdpToIr, octoIconLoader, withRoutes, parseOctoIconName, routeEdges, type MdpDoc } from '@octo-draw/engine'
import { syntheticOcto } from '@octo-draw/engine/synthetic'
import { elementBoxes, renderMdp, type RenderTimings } from '@octo-draw/engine/browser'
import RouteWorker from '@octo-draw/engine/worker?worker'
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import deepOcto from '../../../../packages/engine/fixtures/deep.octo?raw'
import canopy from '../../../../packages/engine/fixtures/eraser/canopy-ai-chatbot-architecture.json'
import canopyGolden from '../../../../packages/engine/fixtures/eraser/canopy-ai-chatbot-architecture-darwin.png?url'
import erd from '../../../../packages/engine/fixtures/eraser/erd-order-system.json'
import erdGolden from '../../../../packages/engine/fixtures/eraser/erd-order-system-darwin.png?url'
import { EXAMPLES } from '../examples'
import { iconSvgString, loadIcons, loadLucide } from '../lib/icons'

/**
 * v2 spike test page (`?engine=1`): Eraser's in-browser render pipeline (`@eraserlabs/render`)
 * fed with MDP produced from octo DSL + ELK placement, or with Eraser corpus fixtures (shown next
 * to their golden PNG). The scene sits in a CSS-transformed camera (wheel = zoom, drag = pan);
 * clicking an element draws a selection box from its positioned DOM.
 *
 * Query params: `src=<id>` picks a source; `window.__engineSpike` exposes state for automation.
 */

interface Source {
	id: string
	label: string
	load: () => Promise<{ doc: MdpDoc; ir?: DiagramIR; layout?: DiagramLayout; layoutMs?: number; routeMs?: number; golden?: string }>
}

/** Official AWS/GCP/Azure packs from the octo server (`/api/icons`), registered with core. */
let packNames: Set<string> | null = null
const packsReady: Promise<void> = (async () => {
	try {
		const res = await fetch('/api/icons/manifest')
		if (!res.ok) return
		const manifest = (await res.json()) as IconCacheManifest
		packNames = new Set()
		for (const pack of Object.values(manifest.packs ?? {})) {
			if (!pack) continue
			for (const n of Object.keys(pack.icons)) packNames.add(n)
			registerIconPack(
				lazyIconPack(pack, async (n) => {
					const r = await fetch(`/api/icons/${pack.vendor}/${encodeURIComponent(n)}.svg`)
					if (!r.ok) throw new Error(String(r.status))
					return r.text()
				}),
			)
		}
	} catch {
		// no server: vendor names fall back to catalog badges
	}
})()

/** Lazy packs answer with a badge until the SVG arrives: trigger the fetch, wait for the change event. */
function awaitPackIcon(name: string): Promise<void> {
	return new Promise((done) => {
		const off = onIconPacksChange(() => {
			if (resolveIcon(name)?.svg !== undefined) {
				off()
				done()
			}
		})
		if (resolveIcon(name)?.svg !== undefined) {
			off()
			done()
		}
		setTimeout(() => {
			off()
			done()
		}, 3000)
	})
}

/** octo's catalog (+ official packs), then the web app's full lucide fallback (what the canvas does). */
async function webIconLoader(name: string): Promise<string> {
	await packsReady
	const bare = parseOctoIconName(name).icon
	if (packNames?.has(bare)) await awaitPackIcon(bare)
	try {
		return await octoIconLoader(name)
	} catch {
		await Promise.all([loadIcons(), loadLucide()])
		const svg = iconSvgString(name, 24)
		if (!svg) throw new Error(`unknown icon "${name}"`)
		return svg
	}
}

const fonts = { inter: interUrl, iconLoader: webIconLoader }

async function fromOcto(code: string, page = '', preRoute = false) {
	const p = parseOctoPages(code).pages.find((x) => x.name === page) ?? parseOctoPages(code).pages[0]
	const t = performance.now()
	const layout = await layoutDiagram(p.ir)
	const layoutMs = performance.now() - t
	const doc = irToMdp(p.ir, layout)
	if (!preRoute) return { doc, ir: p.ir, layout, layoutMs }
	// Route ourselves (no repair pass) on the doc's own geometry and hand the polylines to the
	// renderer as authored points: run() adopts orthogonal routes that cut no entity instead of
	// routing them with its hard-wired infinite repair budget.
	const t2 = performance.now()
	const routed = routeEdges(layoutFromMdp(doc), p.ir, { repair: false })
	const routeMs = performance.now() - t2
	return { doc: withRoutes(doc, routed.edges), ir: p.ir, layout, layoutMs, routeMs }
}

/** Corpus fixture: `{ title, elements }`. Round-trip through octo IR first (the point of the test). */
function fromCorpus(raw: unknown, golden: string, roundTrip: boolean) {
	const src = raw as { elements?: MdpDoc['entities']; entities?: MdpDoc['entities']; connections?: MdpDoc['connections'] }
	const all = src.elements ?? [...(src.entities ?? []), ...(src.connections ?? [])]
	const direct: MdpDoc = { entities: all.filter((e) => !('from' in e)), connections: all.filter((e) => 'from' in e) }
	if (!roundTrip) return { doc: direct, golden }
	const ir = mdpToIr(direct)
	const layout: DiagramLayout = {
		nodes: Object.fromEntries(ir.nodes.map((n) => [n.key, { key: n.key, x: n.geometry?.x ?? 0, y: n.geometry?.y ?? 0, w: n.geometry?.w ?? 120, h: n.geometry?.h ?? 60, isContainer: !!n.isContainer, depth: 0 }])),
		edges: {},
		bounds: { x: 0, y: 0, w: 0, h: 0 },
	}
	return { doc: irToMdp(ir, layout), ir, layout, golden }
}

const SOURCES: Source[] = [
	...EXAMPLES.flatMap((ex) =>
		parseOctoPages(ex.code)
			.pages.filter((p) => p.ir.kind !== 'sequence')
			.map((p) => ({ id: `example:${ex.id}${p.name ? ':' + p.name : ''}`, label: `${ex.label}${p.name ? ' › ' + p.name : ''}`, load: () => fromOcto(ex.code, p.name) })),
	),
	{ id: 'deep', label: 'Deep nesting (5 levels)', load: () => fromOcto(deepOcto) },
	{ id: 'synthetic:50', label: 'Synthetic 50 nodes', load: () => fromOcto(syntheticOcto(50)) },
	{ id: 'synthetic:200', label: 'Synthetic 200 nodes', load: () => fromOcto(syntheticOcto(200)) },
	{ id: 'deep:prerouted', label: 'Deep nesting, pre-routed', load: () => fromOcto(deepOcto, '', true) },
	{ id: 'synthetic:50:prerouted', label: 'Synthetic 50, pre-routed', load: () => fromOcto(syntheticOcto(50), '', true) },
	{ id: 'synthetic:200:prerouted', label: 'Synthetic 200, pre-routed', load: () => fromOcto(syntheticOcto(200), '', true) },
	{ id: 'corpus:canopy', label: 'Corpus: canopy (octo round trip)', load: async () => fromCorpus(canopy, canopyGolden, true) },
	{ id: 'corpus:canopy-direct', label: 'Corpus: canopy (as is)', load: async () => fromCorpus(canopy, canopyGolden, false) },
	{ id: 'corpus:erd', label: 'Corpus: ERD (octo round trip)', load: async () => fromCorpus(erd, erdGolden, true) },
]

interface Camera {
	x: number
	y: number
	k: number
}

interface Stats {
	source: string
	nodes: number
	connections: number
	layoutMs?: number
	routeMs?: number
	adopted?: number
	timings?: RenderTimings
	warnings: string[]
	workerMs?: number
	workerMainMs?: number
	workerRouteMs?: number
	error?: string
}

declare global {
	interface Window {
		__engineSpike?: { status: string; stats: Stats | null; boxes: () => ReturnType<typeof elementBoxes>; select: (id: string) => void; camera: (c: Partial<Camera>) => void }
	}
}

export function EnginePage() {
	const params = new URLSearchParams(location.search)
	const [srcId, setSrcId] = useState(params.get('src') ?? 'example:architecture')
	const [cam, setCam] = useState<Camera>({ x: 24, y: 24, k: Number(params.get('zoom') ?? 0.8) })
	const [stats, setStats] = useState<Stats | null>(null)
	const [status, setStatus] = useState('idle')
	const [golden, setGolden] = useState<string | undefined>()
	const [sel, setSel] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null)
	const hostRef = useRef<HTMLDivElement>(null)
	const viewRef = useRef<HTMLDivElement>(null)
	const lastIr = useRef<{ ir?: DiagramIR; layout?: DiagramLayout }>({})
	const worker = useMemo(() => new RouteWorker(), [])

	const select = (id: string) => {
		const scene = hostRef.current?.querySelector<HTMLElement>('#eraser-scene')
		if (!scene) return
		const b = elementBoxes(scene)[id]
		setSel(b ? { id, ...b } : null)
	}

	useEffect(() => {
		window.__engineSpike = {
			status,
			stats,
			boxes: () => {
				const scene = hostRef.current?.querySelector<HTMLElement>('#eraser-scene')
				return scene ? elementBoxes(scene) : {}
			},
			select,
			camera: (c) => setCam((old) => ({ ...old, ...c })),
		}
		document.body.dataset.engineStatus = status
	})

	useEffect(() => {
		const source = SOURCES.find((s) => s.id === srcId) ?? SOURCES[0]
		let cancelled = false
		setStatus('rendering')
		setSel(null)
		void (async () => {
			try {
				const { doc, ir, layout, layoutMs, routeMs, golden } = await source.load()
				lastIr.current = { ir, layout }
				const out = await renderMdp(hostRef.current!, doc, fonts)
				if (cancelled || !out) return
				setGolden(golden)
				setStats({
					source: source.id,
					nodes: doc.entities.length,
					connections: doc.connections.length,
					layoutMs,
					routeMs,
					// pre-routed connections the renderer kept as-is (same points in, same points out)
					adopted: routeMs === undefined ? undefined : doc.connections.filter((c) => {
						const got = out.result.layout.connections[c.id]?.points
						const pts = c.points as { x: number; y: number }[] | undefined
						return !!got && !!pts && got.length === pts.length && got.every(([x, y], i) => x === Number(c.x) + pts[i].x && y === Number(c.y) + pts[i].y)
					}).length,
					timings: out.timings,
					warnings: out.resolved.warnings.map((w) => `${w.code} ${w.path} ${w.message}`),
				})
				setStatus('done')
			} catch (err) {
				if (cancelled) return
				setStats({ source: source.id, nodes: 0, connections: 0, warnings: [], error: String((err as Error)?.stack ?? err) })
				setStatus('error')
			}
		})()
		return () => {
			cancelled = true
		}
	}, [srcId])

	const routeInWorker = () => {
		const { ir, layout } = lastIr.current
		if (!ir || !layout) return
		const id = Date.now()
		const t = performance.now()
		worker.onmessage = (ev: MessageEvent<{ id: number; result?: { ms: number }; error?: string }>) => {
			if (ev.data.id !== id) return
			const workerMs = performance.now() - t
			const t2 = performance.now()
			routeEdges(layout, ir)
			const workerMainMs = performance.now() - t2
			setStats((s) => (s ? { ...s, workerMs, workerRouteMs: ev.data.result?.ms, workerMainMs, error: ev.data.error ?? s.error } : s))
		}
		worker.postMessage({ id, layout, ir })
	}

	// camera: wheel zooms around the cursor, drag on empty canvas pans
	useEffect(() => {
		const view = viewRef.current!
		const onWheel = (e: WheelEvent) => {
			e.preventDefault()
			const r = view.getBoundingClientRect()
			const px = e.clientX - r.left
			const py = e.clientY - r.top
			setCam((c) => {
				const k = Math.min(4, Math.max(0.1, c.k * Math.exp(-e.deltaY * 0.0015)))
				return { k, x: px - ((px - c.x) * k) / c.k, y: py - ((py - c.y) * k) / c.k }
			})
		}
		view.addEventListener('wheel', onWheel, { passive: false })
		return () => view.removeEventListener('wheel', onWheel)
	}, [])

	const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
	const onPointerDown = (e: React.PointerEvent) => {
		drag.current = { x: e.clientX, y: e.clientY, moved: false }
		;(e.target as Element).setPointerCapture?.(e.pointerId)
	}
	const onPointerMove = (e: React.PointerEvent) => {
		const d = drag.current
		if (!d) return
		const dx = e.clientX - d.x
		const dy = e.clientY - d.y
		if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true
		d.x = e.clientX
		d.y = e.clientY
		if (d.moved) setCam((c) => ({ ...c, x: c.x + dx, y: c.y + dy }))
	}
	const onPointerUp = (e: React.PointerEvent) => {
		const d = drag.current
		drag.current = null
		if (d?.moved) return
		// click: hit-test the real DOM under the pointer (works through the camera transform)
		const hit = document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest<HTMLElement>('#eraser-scene > [data-mdp-id]')).find(Boolean)
		if (hit) select(hit.dataset.mdpId!)
		else setSel(null)
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh', font: '13px Inter, system-ui, sans-serif', background: '#f7f7f8', color: '#111' }}>
			<div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #ddd', background: '#fff' }}>
				<strong>octo-draw v2 spike · Eraser render</strong>
				<select value={srcId} onChange={(e) => setSrcId(e.target.value)} data-testid="source">
					{SOURCES.map((s) => (
						<option key={s.id} value={s.id}>
							{s.label}
						</option>
					))}
				</select>
				<button onClick={() => setCam({ x: 24, y: 24, k: 1 })}>100%</button>
				<button onClick={routeInWorker} disabled={!lastIr.current.ir}>
					Route in worker
				</button>
				<span data-testid="status">{status}</span>
				{stats && (
					<span data-testid="stats">
						{stats.nodes} entities · {stats.connections} connections
						{stats.layoutMs !== undefined && ` · ELK ${stats.layoutMs.toFixed(0)} ms`}
						{stats.routeMs !== undefined && ` · pre-route ${stats.routeMs.toFixed(0)} ms (${stats.adopted}/${stats.connections} adopted by render)`}
						{stats.timings && ` · resolve ${stats.timings.resolveMs.toFixed(0)} ms · run ${stats.timings.runMs.toFixed(0)} ms`}
						{stats.workerMs !== undefined && ` · worker route ${stats.workerRouteMs?.toFixed(0)} ms (round trip ${stats.workerMs.toFixed(0)} ms, main thread ${stats.workerMainMs?.toFixed(0)} ms)`}
						{stats.warnings.length > 0 && ` · ${stats.warnings.length} warnings`}
					</span>
				)}
				{sel && <span data-testid="selection">selected {sel.id}: {Math.round(sel.x)},{Math.round(sel.y)} {Math.round(sel.w)}×{Math.round(sel.h)}</span>}
			</div>
			{stats?.error && <pre style={{ color: '#b00', margin: 8, whiteSpace: 'pre-wrap' }}>{stats.error}</pre>}
			<div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
				<div ref={viewRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} style={{ position: 'relative', flex: 1, overflow: 'hidden', cursor: 'grab', background: '#fff' }}>
					<div style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})` }}>
						<div ref={hostRef} />
						{sel && (
							<div
								data-testid="selection-box"
								style={{ position: 'absolute', left: sel.x - 3, top: sel.y - 3, width: sel.w + 6, height: sel.h + 6, border: `${2 / cam.k}px solid #6366f1`, borderRadius: 4, pointerEvents: 'none', boxShadow: '0 0 0 4px rgba(99,102,241,.15)' }}
							/>
						)}
					</div>
				</div>
				{golden && (
					<div style={{ width: '45%', overflow: 'auto', borderLeft: '1px solid #ddd', background: '#fff' }}>
						<div style={{ padding: 6, color: '#666' }}>Golden PNG (Eraser corpus, darwin)</div>
						<img src={golden} style={{ maxWidth: '100%' }} alt="golden" />
					</div>
				)}
			</div>
		</div>
	)
}
