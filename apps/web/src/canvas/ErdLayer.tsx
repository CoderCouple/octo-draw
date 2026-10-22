import { memo } from 'react'
import type { Cardinality, DiagramIR, DiagramLayout, IREdge, IRNode, LaidOutEdge, LaidOutNode, Point } from '@octo-draw/core'
import { ERD_FIELD_FONT, ERD_HEAD_FONT, entityMetrics, fieldBadges } from '@octo-draw/core/src/layout/erd'
import { ERD_HEAD_H } from '@octo-draw/core/src/layout/erdRoute'
import { edgeColor, nodeColors, resolveColor, SURFACE, type Theme } from '../lib/colors'
import { useIcons } from '../lib/icons'
import { fontFor, makeMeasure } from '../lib/text'
import { IconGlyph } from './DiagramLayer'
import { roundedPolyline, roundedRect } from './geometry'

interface Props {
	ir: DiagramIR
	layout: DiagramLayout
	theme: Theme
	selectedKey: string | null
	editingKey: string | null
}

type Measure = (t: string, size: number) => { w: number; h: number }

/** ERD: entity tables (header + attribute rows with PK/FK badges) and crow's-foot (or Chen) relationships. */
export const ErdLayer = memo(function ErdLayer({ ir, layout, theme, selectedKey, editingKey }: Props) {
	useIcons((s) => s.loaded)
	const measure = makeMeasure(ir.style.typeface)
	const notation = ir.erd?.notation ?? 'crows-feet'
	const filter = ir.style.styleMode === 'shadow' ? 'url(#octo-erd-shadow)' : undefined
	return (
		<g data-layer="diagram" data-kind="erd" fontFamily={fontFor(ir.style.typeface)}>
			<defs>
				<filter id="octo-erd-shadow" x="-20%" y="-20%" width="140%" height="160%">
					<feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#000000" floodOpacity={theme === 'dark' ? 0.5 : 0.08} />
				</filter>
			</defs>
			{ir.edges.map((e) => {
				const le = layout.edges[e.key]
				return le ? <Relationship key={e.key} edge={e} laid={le} theme={theme} notation={notation} measure={measure} /> : null
			})}
			{ir.nodes.map((n) => {
				const box = layout.nodes[n.key]
				return box ? <Entity key={n.key} node={n} box={box} theme={theme} mode={ir.style.colorMode} filter={filter} selected={selectedKey === n.key} editing={editingKey === n.key} measure={measure} /> : null
			})}
		</g>
	)
})

function Entity({
	node,
	box,
	theme,
	mode,
	filter,
	selected,
	editing,
	measure,
}: {
	node: IRNode
	box: LaidOutNode
	theme: Theme
	mode: DiagramIR['style']['colorMode']
	filter?: string
	selected: boolean
	editing: boolean
	measure: Measure
}) {
	const s = SURFACE[theme]
	const tinted = !!resolveColor(node.style?.color)
	const c = nodeColors(node.style?.color, mode, theme)
	const headFill = tinted || mode === 'bold' ? c.fill : s.groupFill
	const headText = tinted || mode === 'bold' ? c.text : s.text
	const stroke = tinted ? c.stroke : s.nodeStroke
	const m = entityMetrics(node, measure)
	const label = node.label ?? node.key
	const fields = node.fields ?? []
	const rows = box.fields ?? []
	const r = 8
	const hasRows = rows.length > 0
	return (
		<g data-node={node.key} transform={`translate(${box.x},${box.y})`} style={{ cursor: 'pointer' }}>
			<path d={roundedRect(box.w, box.h, r)} fill={s.nodeFill} stroke={stroke} strokeWidth={1.4} filter={filter} />
			<path
				d={hasRows ? `M0,${ERD_HEAD_H} V${r} Q0,0 ${r},0 H${box.w - r} Q${box.w},0 ${box.w},${r} V${ERD_HEAD_H} Z` : roundedRect(box.w, box.h, r)}
				fill={headFill === 'none' ? s.nodeFill : headFill}
				stroke="none"
			/>
			{hasRows && <line x1={0} y1={ERD_HEAD_H} x2={box.w} y2={ERD_HEAD_H} stroke={stroke} strokeWidth={1.2} />}
			<path d={roundedRect(box.w, box.h, r)} fill="none" stroke={stroke} strokeWidth={1.4} />
			{node.icon && <IconGlyph name={node.icon} x={12} y={ERD_HEAD_H / 2 - 9} size={18} color={tinted ? c.icon : headText} />}
			{!editing && (
				<text x={node.icon ? 38 : 14} y={ERD_HEAD_H / 2} fontSize={ERD_HEAD_FONT} fontWeight={650} fill={headText} dominantBaseline="central">
					{label}
				</text>
			)}
			{rows.map((row, i) => {
				const f = fields.find((x) => x.name === row.name) ?? fields[i]
				if (!f) return null
				const cy = row.y + row.h / 2
				const badges = fieldBadges(f.meta)
				const key = badges.includes('PK')
				return (
					<g key={row.name + i}>
						{i > 0 && <line x1={10} y1={row.y} x2={box.w - 10} y2={row.y} stroke={s.labelBorder} strokeWidth={1} />}
						<text x={m.nameX} y={cy} fontSize={ERD_FIELD_FONT} fontWeight={key ? 650 : 500} fill={s.text} dominantBaseline="central">
							{f.name}
						</text>
						{f.type && (
							<text x={m.typeX} y={cy} fontSize={ERD_FIELD_FONT} fill={s.muted} dominantBaseline="central">
								{f.type}
							</text>
						)}
						{badges.map((b, j) => {
							const bx = box.w - 12 - (badges.length - j) * 28 + 4
							return (
								<g key={b + j} transform={`translate(${bx},${cy - 8})`}>
									<rect width={24} height={16} rx={4} fill={b === 'PK' ? s.text : 'none'} stroke={b === 'PK' ? s.text : s.muted} strokeWidth={1} />
									<text x={12} y={8.5} textAnchor="middle" dominantBaseline="central" fontSize={8.5} fontWeight={700} fill={b === 'PK' ? s.bg : s.muted}>
										{b}
									</text>
								</g>
							)
						})}
					</g>
				)
			})}
			{selected && <path data-export="skip" d={roundedRect(box.w + 8, box.h + 8, 12)} transform="translate(-4,-4)" fill="none" stroke={s.select} strokeWidth={1.5} strokeDasharray="5 4" />}
		</g>
	)
}

const unit = (a: Point, b: Point) => {
	const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
	return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
}

/** Crow's-foot marker at `tip` (on the entity border); `toward` is the next point along the line. */
function crowsFoot(tip: Point, toward: Point, many: boolean): string {
	const u = unit(tip, toward)
	const v = { x: -u.y, y: u.x }
	const at = (d: number, side: number) => `${tip.x + u.x * d + v.x * side},${tip.y + u.y * d + v.y * side}`
	let d = `M${at(18, -6)} L${at(18, 6)}`
	if (many) {
		d += ` M${at(0, -7)} L${at(13, 0)} L${at(0, 7)} M${at(0, 0)} L${at(13, 0)}`
	} else {
		d += ` M${at(12, -6)} L${at(12, 6)}`
	}
	return d
}

function Relationship({ edge, laid, theme, notation, measure }: { edge: IREdge; laid: LaidOutEdge; theme: Theme; notation: 'crows-feet' | 'chen'; measure: Measure }) {
	const s = SURFACE[theme]
	const color = edgeColor(edge.style?.color, theme)
	const pts = laid.points
	if (pts.length < 2) return null
	const card: Cardinality = edge.cardinality ?? '1-1'
	const [fromMany, toMany] = [card[0] === 'n', card[2] === 'n']
	const dash = edge.style?.dash ?? edge.line.dash
	const dashArray = dash === 'dotted' ? '2 5' : dash === 'dashed' ? '7 5' : undefined
	const a = pts[0]
	const b = pts[pts.length - 1]
	const a2 = pts[1]
	const b2 = pts[pts.length - 2]
	let markers = null
	if (notation === 'crows-feet') {
		markers = <path d={`${crowsFoot(a, a2, fromMany)} ${crowsFoot(b, b2, toMany)}`} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
	} else {
		const tag = (tip: Point, toward: Point, many: boolean, alt: boolean) => {
			const u = unit(tip, toward)
			const p = { x: tip.x + u.x * 14 - u.y * 10, y: tip.y + u.y * 14 + u.x * 10 }
			return (
				<text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill={color}>
					{many ? (alt ? 'M' : 'N') : '1'}
				</text>
			)
		}
		markers = (
			<>
				{tag(a, a2, fromMany, false)}
				{tag(b, b2, toMany, fromMany)}
			</>
		)
	}
	let label = null
	if (edge.label && laid.labelAt) {
		const m = measure(edge.label, 12)
		const { x, y } = laid.labelAt
		label =
			notation === 'chen' ? (
				<g transform={`translate(${x},${y})`}>
					<path d={`M${-m.w / 2 - 18},0 L0,${-m.h / 2 - 10} L${m.w / 2 + 18},0 L0,${m.h / 2 + 10} Z`} fill={s.labelBg} stroke={color} strokeWidth={1.2} />
					<text textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={500} fill={s.text}>
						{edge.label}
					</text>
				</g>
			) : (
				<g transform={`translate(${x},${y})`}>
					<rect x={-m.w / 2 - 6} y={-m.h / 2 - 3} width={m.w + 12} height={m.h + 6} rx={(m.h + 6) / 2} fill={s.labelBg} stroke={s.labelBorder} strokeWidth={1} />
					<text textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={500} fill={s.text}>
						{edge.label}
					</text>
				</g>
			)
	}
	return (
		<g data-edge={edge.key} pointerEvents="none">
			<path d={roundedPolyline(pts, 8)} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={dashArray} strokeLinecap="round" strokeLinejoin="round" />
			{markers}
			{label}
		</g>
	)
}
