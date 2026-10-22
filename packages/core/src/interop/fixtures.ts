/**
 * Hand-built tldraw v5 snapshot fixtures, shaped like the records Octonote's
 * mermaid importer (`flowchartToCanvas`) and the tldraw editor produce.
 */

import { encodePoints } from './b64points'

const PAGE = 'page:page'
let z = 0
const idx = () => `a${(z++).toString(36)}`

const rt = (text: string) => ({
	type: 'doc',
	content: text.split('\n').map((l) => (l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' })),
})

const shape = (id: string, type: string, x: number, y: number, props: Record<string, unknown>, parentId = PAGE, rotation = 0) => ({
	id,
	typeName: 'shape',
	type,
	x,
	y,
	rotation,
	index: idx(),
	parentId,
	isLocked: false,
	opacity: 1,
	meta: {},
	props,
})

const geo = (o: { geo?: string; w: number; h: number; label: string; color?: string; fill?: string; dash?: string; url?: string }) => ({
	geo: o.geo ?? 'rectangle',
	w: o.w,
	h: o.h,
	richText: rt(o.label),
	color: o.color ?? 'black',
	labelColor: o.color ?? 'black',
	fill: o.fill ?? 'semi',
	dash: o.dash ?? 'draw',
	size: 's',
	font: 'sans',
	align: 'middle',
	verticalAlign: 'middle',
	growY: 0,
	url: o.url ?? '',
	scale: 1,
	flipX: false,
	flipY: false,
})

const arrow = (id: string, x: number, y: number, o: { label?: string; dash?: string; end?: { x: number; y: number }; start?: string; color?: string }) =>
	shape(id, 'arrow', x, y, {
		kind: 'arc',
		labelColor: 'black',
		color: o.color ?? 'grey',
		fill: 'none',
		dash: o.dash ?? 'solid',
		size: 's',
		arrowheadStart: o.start ?? 'none',
		arrowheadEnd: 'arrow',
		font: 'sans',
		start: { x: 0, y: 0 },
		end: o.end ?? { x: 100, y: 0 },
		bend: 0,
		richText: rt(o.label ?? ''),
		labelPosition: 0.5,
		scale: 1,
		elbowMidPoint: 0.5,
	})

const bind = (arrowId: string, terminal: 'start' | 'end', toId: string) => ({
	id: `binding:${arrowId.slice(6)}-${terminal}`,
	typeName: 'binding',
	type: 'arrow',
	fromId: arrowId,
	toId,
	meta: {},
	props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
})

/** `flowchart LR; subgraph app [App servers] A[API] --> C{Cache hit?} end; U((User)) --> A; C -->|yes| R[(Redis)]` + extras. */
export function octonoteFlowchart() {
	z = 0
	const records = [
		{ id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
		{ id: PAGE, typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
		shape('shape:group-app', 'geo', 180, 20, { ...geo({ w: 420, h: 160, label: 'App servers', color: 'grey', fill: 'none', dash: 'dashed' }), align: 'start', verticalAlign: 'start' }),
		shape('shape:node-U', 'geo', 0, 60, geo({ geo: 'ellipse', w: 120, h: 120, label: 'User' })),
		shape('shape:node-A', 'geo', 200, 80, geo({ w: 120, h: 56, label: 'API', url: 'https://example.com' })),
		shape('shape:node-C', 'geo', 400, 70, geo({ geo: 'diamond', w: 174, h: 90, label: 'Cache hit?' })),
		shape('shape:node-R', 'geo', 700, 80, geo({ w: 120, h: 56, label: 'Redis', color: 'blue' })),
		shape('shape:node-H', 'geo', 700, 300, geo({ geo: 'heart', w: 80, h: 80, label: 'Love\nit' })),
		shape('shape:node-E', 'geo', 900, 300, geo({ w: 80, h: 80, label: '' })),
		arrow('shape:edge-0', 60, 120, {}),
		arrow('shape:edge-1', 260, 108, {}),
		arrow('shape:edge-2', 487, 115, { label: 'yes', dash: 'dashed', start: 'arrow', color: 'red' }),
		bind('shape:edge-0', 'start', 'shape:node-U'),
		bind('shape:edge-0', 'end', 'shape:node-A'),
		bind('shape:edge-1', 'start', 'shape:node-A'),
		bind('shape:edge-1', 'end', 'shape:node-C'),
		bind('shape:edge-2', 'start', 'shape:node-C'),
		bind('shape:edge-2', 'end', 'shape:node-R'),
	]
	return { store: Object.fromEntries(records.map((r) => [r.id, r])), schema: { schemaVersion: 2, sequences: {} } }
}

/** A hand-drawn board: frame with children, text, draw, line, note, image, loose arrow. */
export function sketchBoard() {
	z = 0
	const path = encodePoints([{ x: 0, y: 0, z: 0.5 }, { x: 10, y: 5, z: 0.6 }, { x: 20, y: 0, z: 0.4 }])
	const records = [
		{ id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
		{ id: 'page:b', typeName: 'page', name: 'Second', index: 'a2', meta: {} },
		{ id: 'page:a', typeName: 'page', name: 'Board', index: 'a1', meta: {} },
		{ id: 'asset:img', typeName: 'asset', type: 'image', props: { src: 'https://example.com/cat.png', w: 10, h: 10, name: 'cat.png', isAnimated: false, mimeType: 'image/png' }, meta: {} },
		shape('shape:frame', 'frame', 1000, 1000, { w: 400, h: 300, name: 'Backend', color: 'black' }, 'page:a'),
		shape('shape:inner', 'geo', 50, 60, geo({ w: 120, h: 60, label: 'Worker', color: 'green' }), 'shape:frame'),
		shape('shape:inner2', 'geo', 200, 60, geo({ w: 120, h: 60, label: 'Worker', color: 'violet' }), 'shape:frame'),
		shape('shape:group', 'group', 100, 100, {}, 'page:a'),
		shape('shape:text', 'text', 10, 20, { color: 'red', size: 'l', font: 'draw', textAlign: 'start', w: 150, richText: rt('Hello\nworld'), scale: 1, autoSize: true }, 'shape:group'),
		shape('shape:draw', 'draw', 300, 300, { color: 'blue', fill: 'none', dash: 'draw', size: 'm', segments: [{ type: 'free', path }], isComplete: true, isClosed: false, isPen: true, scale: 1, scaleX: 2, scaleY: 1 }, 'page:a'),
		shape('shape:line', 'line', 0, 500, { color: 'black', dash: 'solid', size: 's', spline: 'line', scale: 1, points: { b: { id: 'b', index: 'a2', x: 50, y: 50 }, a: { id: 'a', index: 'a1', x: 0, y: 0 } } }, 'page:a'),
		shape('shape:note', 'note', 600, 0, { color: 'yellow', labelColor: 'black', size: 'm', font: 'draw', fontSizeAdjustment: 1, align: 'middle', verticalAlign: 'middle', growY: 0, url: '', richText: rt('Remember'), scale: 1, textLastEditedBy: null }, 'page:a'),
		shape('shape:img', 'image', 800, 0, { w: 64, h: 48, playing: true, url: '', assetId: 'asset:img', crop: null, flipX: false, flipY: false, altText: '' }, 'page:a'),
		arrow('shape:loose', 0, 800, { end: { x: 80, y: 40 } }),
		shape('shape:other-page', 'geo', 0, 0, geo({ w: 10, h: 10, label: 'Elsewhere' }), 'page:b'),
		shape('shape:rotated', 'geo', 0, 1500, geo({ w: 100, h: 50, label: 'Tilted' }), 'page:a', 0.5),
	]
	// the loose arrow sits on page:a too
	;(records.find((r) => r.id === 'shape:loose') as { parentId: string }).parentId = 'page:a'
	return { document: { store: Object.fromEntries(records.map((r) => [r.id, r])), schema: { schemaVersion: 2, sequences: {} } }, session: {} }
}
