import type { Point } from '@octo-draw/core'
import { useCamera } from './camera'
import type { Box } from './freehand'
import type { Guide, HandleId } from './snap'
import { roundedPolyline } from './geometry'

export const HANDLES: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const CURSOR: Record<HandleId, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }

function handlePoint(b: Box, h: HandleId): Point {
	const x = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2
	const y = h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : b.y + b.h / 2
	return { x, y }
}

interface Props {
	color: string
	bg: string
	/** overall selection box */
	box: Box | null
	/** per-item outlines (multi-select) */
	items: Box[]
	/** show the 8 resize handles on `box` */
	resizable: boolean
	/** single arrow selected: endpoint handles instead */
	endpoints: Point[] | null
	guides: Guide[]
	marquee: Box | null
	edge: Point[] | null
}

/** Selection chrome in one layer: outlines, handles, snap guides, marquee, selected edge. Sizes stay constant on screen. */
export function SelectionOverlay({ color, bg, box, items, resizable, endpoints, guides, marquee, edge }: Props) {
	const z = useCamera((c) => c.z)
	const px = 1 / z
	const hs = 8 * px
	const pad = 4 * px
	const outer = box && { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 }
	const smallW = !!outer && outer.w * z < 28
	const smallH = !!outer && outer.h * z < 28
	return (
		<g data-export="skip" className="selection-overlay">
			{edge && (
				<path d={roundedPolyline(edge, 10)} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={6 * px} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
			)}
			{items.map((b, i) => (
				<rect key={i} x={b.x - 2 * px} y={b.y - 2 * px} width={b.w + 4 * px} height={b.h + 4 * px} rx={3 * px} fill="none" stroke={color} strokeOpacity={0.45} strokeWidth={px} pointerEvents="none" />
			))}
			{outer && !endpoints && (
				<rect x={outer.x} y={outer.y} width={outer.w} height={outer.h} fill="none" stroke={color} strokeWidth={1.25 * px} pointerEvents="none" />
			)}
			{outer &&
				resizable &&
				!endpoints &&
				HANDLES.filter((h) => !(smallW && (h === 'n' || h === 's')) && !(smallH && (h === 'e' || h === 'w'))).map((h) => {
					const p = handlePoint(outer, h)
					return (
						<g key={h} data-handle={h} style={{ cursor: CURSOR[h] }}>
							<rect x={p.x - hs} y={p.y - hs} width={hs * 2} height={hs * 2} fill="transparent" />
							<rect x={p.x - hs / 2} y={p.y - hs / 2} width={hs} height={hs} rx={1.5 * px} fill={bg} stroke={color} strokeWidth={1.25 * px} />
						</g>
					)
				})}
			{endpoints?.map((p, i) => (
				<g key={i} data-handle={i === 0 ? 'start' : 'end'} style={{ cursor: 'crosshair' }}>
					<circle cx={p.x} cy={p.y} r={hs} fill="transparent" />
					<circle cx={p.x} cy={p.y} r={hs * 0.6} fill={bg} stroke={color} strokeWidth={1.5 * px} />
				</g>
			))}
			{guides.map((g, i) =>
				g.axis === 'x' ? (
					<line key={i} x1={g.at} x2={g.at} y1={g.from - 8 * px} y2={g.to + 8 * px} stroke={color} strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} pointerEvents="none" />
				) : (
					<line key={i} y1={g.at} y2={g.at} x1={g.from - 8 * px} x2={g.to + 8 * px} stroke={color} strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} pointerEvents="none" />
				),
			)}
			{marquee && (
				<rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill={color} fillOpacity={0.06} stroke={color} strokeOpacity={0.6} strokeWidth={px} pointerEvents="none" />
			)}
		</g>
	)
}
