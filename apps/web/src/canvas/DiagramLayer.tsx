import { createElement, memo } from 'react'
import type { DiagramIR, DiagramLayout, IREdge, IRNode, LaidOutEdge, LaidOutNode } from '@octo-draw/core'
import { ICON_SIZE, iconPlacement } from '@octo-draw/core/src/layout/sizing'
import { edgeColor, groupColors, nodeColors, SURFACE, type Theme } from '../lib/colors'
import { getIcon, iconCatalog, useIcons } from '../lib/icons'
import { fontFor, makeMeasure } from '../lib/text'
import { SequenceLayer } from './SequenceLayer'
import { ErdLayer } from './ErdLayer'
import { approachPoint, arrowHead, contentCenterY, roundedPolyline, roundedRect, shapePath, trimPolyline } from './geometry'

interface Props {
	ir: DiagramIR
	layout: DiagramLayout
	theme: Theme
	selectedKey: string | null
	editingKey: string | null
}

export const DiagramLayer = memo(function DiagramLayer({ ir, layout, theme, selectedKey, editingKey }: Props) {
	const iconsReady = useIcons((s) => s.version)
	// other diagram kinds have their own renderers
	if (ir.kind === 'sequence' && layout.sequence) return <SequenceLayer ir={ir} layout={layout} theme={theme} selectedKey={selectedKey} editingKey={editingKey} />
	if (ir.kind === 'erd') return <ErdLayer ir={ir} layout={layout} theme={theme} selectedKey={selectedKey} editingKey={editingKey} />
	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	const mode = ir.style.colorMode
	const styleMode = ir.style.styleMode ?? 'plain'
	const measure = makeMeasure(ir.style.typeface)
	const laid = Object.values(layout.nodes)
	const groups = laid.filter((n) => n.isContainer).sort((a, b) => a.depth - b.depth)
	const leaves = laid.filter((n) => !n.isContainer)
	const filter = styleMode === 'shadow' ? 'url(#octo-shadow)' : styleMode === 'watercolor' ? 'url(#octo-watercolor)' : undefined
	return (
		<g data-layer="diagram" fontFamily={fontFor(ir.style.typeface)}>
			<defs>
				<filter id="octo-shadow" x="-20%" y="-20%" width="140%" height="160%">
					<feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#000000" floodOpacity={theme === 'dark' ? 0.5 : 0.08} />
				</filter>
				<filter id="octo-watercolor" x="-10%" y="-10%" width="120%" height="120%">
					<feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="3" result="noise" />
					<feDisplacementMap in="SourceGraphic" in2="noise" scale="4" />
				</filter>
			</defs>
			{groups.map((g) => {
				const node = byKey.get(g.key)
				return node ? (
					<GroupView key={g.key} iconsReady={iconsReady} node={node} box={g} mode={mode} theme={theme} selected={selectedKey === g.key} editing={editingKey === g.key} />
				) : null
			})}
			{ir.edges.map((e) => {
				const le = layout.edges[e.key]
				return le ? <EdgeView key={e.key} edge={e} laid={le} theme={theme} measure={measure} /> : null
			})}
			{leaves.map((n) => {
				const node = byKey.get(n.key)
				return node ? (
					<NodeView
						key={n.key}
						iconsReady={iconsReady}
						node={node}
						box={n}
						mode={mode}
						theme={theme}
						filter={filter}
						selected={selectedKey === n.key}
						editing={editingKey === n.key}
						measure={measure}
					/>
				) : null
			})}
		</g>
	)
})

type Measure = (t: string, s: number) => { w: number; h: number }

const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/**
 * A diagram icon at (x, y): catalog icons (brand logos, glyphs, vendor badges)
 * in the node's monochrome icon color, or the brand color for `color: brand`;
 * full-lucide fallback; a text badge for unknown names. Plain SVG, so exports keep it.
 */
export function IconGlyph({ name, x, y, size, color, brand, surface }: { name: string; x: number; y: number; size: number; color: string; brand?: boolean; surface?: string }) {
	const hit = getIcon(name)
	const cat = iconCatalog()
	if (hit?.kind === 'catalog' && cat) {
		const { icon } = hit
		if (icon.svg !== undefined) {
			// official vendor icon: sanitized, id-scoped markup that carries its own colors
			return <svg x={x} y={y} width={size} height={size} viewBox={icon.viewBox} overflow="visible" data-icon={icon.name} dangerouslySetInnerHTML={{ __html: icon.svg }} />
		}
		const bg = surface ?? '#ffffff'
		const ink = cat.iconColor(icon, color, { brand, background: bg })
		const paint = Object.fromEntries(Object.entries(cat.iconPaint(icon, ink)).map(([k, v]) => [camel(k), v]))
		const b = icon.badge ? cat.badgeBox(icon.badge) : null
		return (
			<svg x={x} y={y} width={size} height={size} viewBox={icon.viewBox} overflow="visible" data-icon={icon.name} {...paint}>
				{icon.nodes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
				{b && (
					<>
						<rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.rx} fill={bg} stroke={ink} strokeWidth={1.2} />
						<text x={b.textX} y={b.textY} textAnchor="middle" dominantBaseline="central" fontSize={b.fontSize} fontWeight={700} fill={ink} stroke="none">
							{icon.badge}
						</text>
					</>
				)}
			</svg>
		)
	}
	if (hit?.kind === 'lucide') {
		return (
			<svg x={x} y={y} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" overflow="visible">
				{hit.nodes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
			</svg>
		)
	}
	const text = name.replace(/^(aws|gcp|azure)-/, '').slice(0, 5).toUpperCase()
	return (
		<g transform={`translate(${x},${y})`}>
			<rect width={size} height={size} rx={4} fill="none" stroke={color} strokeWidth={1.2} />
			<text x={size / 2} y={size / 2 + 2.6} textAnchor="middle" fontSize={text.length > 3 ? 6 : 7.5} fontWeight={700} fill={color}>
				{text}
			</text>
		</g>
	)
}

function Lines({ text, x, y, size, weight, fill, anchor = 'middle' }: { text: string; x: number; y: number; size: number; weight: number; fill: string; anchor?: 'middle' | 'start' }) {
	const lines = text.split('\n')
	const lh = size * 1.3
	const top = y - ((lines.length - 1) * lh) / 2
	return (
		<text x={x} textAnchor={anchor} fontSize={size} fontWeight={weight} fill={fill} dominantBaseline="central">
			{lines.map((l, i) => (
				<tspan key={i} x={x} y={top + i * lh}>
					{l}
				</tspan>
			))}
		</text>
	)
}

const NodeView = memo(function NodeView({
	node,
	box,
	mode,
	theme,
	filter,
	selected,
	editing,
	measure,
}: {
	iconsReady: number
	node: IRNode
	box: LaidOutNode
	mode: DiagramIR['style']['colorMode']
	theme: Theme
	filter?: string
	selected: boolean
	editing: boolean
	measure: Measure
}) {
	const c = nodeColors(node.style?.color, mode, theme)
	const brand = node.style?.color === 'brand'
	const surface = c.fill === 'none' ? SURFACE[theme].bg : c.fill
	const { d, detail } = shapePath(node.shape, box.w, box.h)
	const label = node.label ?? node.key
	const cy = contentCenterY(node.shape, box.h)
	const fontSize = 14
	const textW = measure(label, fontSize).w
	const lineCount = label.split('\n').length
	let content
	if (node.icon && iconPlacement(node.shape) === 'left') {
		const total = ICON_SIZE + 8 + textW
		const sx = box.w / 2 - total / 2
		content = (
			<>
				<IconGlyph name={node.icon} x={sx} y={cy - ICON_SIZE / 2} size={ICON_SIZE} color={c.icon} brand={brand} surface={surface} />
				{!editing && <Lines text={label} x={sx + ICON_SIZE + 8} y={cy} size={fontSize} weight={500} fill={c.text} anchor="start" />}
			</>
		)
	} else if (node.icon) {
		const textH = lineCount * fontSize * 1.3
		const total = ICON_SIZE + 6 + textH
		const top = cy - total / 2
		content = (
			<>
				<IconGlyph name={node.icon} x={box.w / 2 - ICON_SIZE / 2} y={top} size={ICON_SIZE} color={c.icon} brand={brand} surface={surface} />
				{!editing && <Lines text={label} x={box.w / 2} y={top + ICON_SIZE + 6 + textH / 2} size={fontSize} weight={500} fill={c.text} />}
			</>
		)
	} else {
		content = !editing && <Lines text={label} x={box.w / 2} y={cy} size={fontSize} weight={500} fill={c.text} />
	}
	const sel = SURFACE[theme].select
	return (
		<g data-node={node.key} transform={`translate(${box.x},${box.y})`} style={{ cursor: 'pointer' }}>
			<path d={d} fill={c.fill === 'none' ? SURFACE[theme].bg : c.fill} fillOpacity={c.fill === 'none' ? 0.001 : 1} stroke={c.stroke} strokeWidth={mode === 'outline' ? 2 : 1.5} filter={filter} />
			{detail && <path d={detail} fill="none" stroke={c.stroke} strokeWidth={1.5} />}
			{content}
			{node.link && (
				<g transform={`translate(${box.w - 16},4)`} opacity={0.7}>
					<IconGlyph name="external-link" x={0} y={0} size={11} color={c.icon} />
				</g>
			)}
			{selected && (
				<path data-export="skip" d={roundedRect(box.w + 8, box.h + 8, 10)} transform="translate(-4,-4)" fill="none" stroke={sel} strokeWidth={1.5} strokeDasharray="5 4" />
			)}
		</g>
	)
})

const GroupView = memo(function GroupView({
	node,
	box,
	mode,
	theme,
	selected,
	editing,
}: {
	iconsReady: number
	node: IRNode
	box: LaidOutNode
	mode: DiagramIR['style']['colorMode']
	theme: Theme
	selected: boolean
	editing: boolean
}) {
	const c = groupColors(node.style?.color, mode, theme)
	const label = node.label ?? node.key
	const iconOffset = node.icon ? 22 : 0
	return (
		<g data-node={node.key} transform={`translate(${box.x},${box.y})`}>
			<path d={roundedRect(box.w, box.h, 12)} fill={c.fill === 'none' ? SURFACE[theme].bg : c.fill} fillOpacity={c.fill === 'none' ? 0.001 : 1} stroke={c.stroke} strokeWidth={1.2} strokeDasharray={node.style?.dash === 'dotted' || node.ext?.dash === 'dotted' ? '4 4' : undefined} />
			<g data-group-header="" style={{ cursor: 'pointer' }}>
				<rect x={0} y={0} width={box.w} height={36} fill="transparent" />
				{node.icon && <IconGlyph name={node.icon} x={14} y={11} size={16} color={c.text} brand={node.style?.color === 'brand'} surface={c.fill === 'none' ? SURFACE[theme].bg : c.fill} />}
				{!editing && (
					<text x={14 + iconOffset} y={19} fontSize={13} fontWeight={600} fill={c.text} dominantBaseline="central">
						{label}
					</text>
				)}
			</g>
			{selected && <path data-export="skip" d={roundedRect(box.w + 8, box.h + 8, 14)} transform="translate(-4,-4)" fill="none" stroke={SURFACE[theme].select} strokeWidth={1.5} strokeDasharray="5 4" />}
		</g>
	)
})

const EdgeView = memo(function EdgeView({ edge, laid, theme, measure }: { edge: IREdge; laid: LaidOutEdge; theme: Theme; measure: Measure }) {
	const color = edgeColor(edge.style?.color, theme)
	const pts = laid.points
	if (pts.length < 2) return null
	const hasEnd = edge.arrow.end === 'arrow'
	const hasStart = edge.arrow.start === 'arrow'
	const line = trimPolyline(pts, hasStart ? 6 : 0, hasEnd ? 6 : 0)
	const dash = edge.style?.dash ?? edge.line.dash
	const dashArray = dash === 'dotted' ? '1.5 5' : dash === 'dashed' ? '7 5' : undefined
	let label = null
	if (edge.label && laid.labelAt) {
		const m = measure(edge.label, 12)
		label = (
			<g transform={`translate(${laid.labelAt.x},${laid.labelAt.y})`}>
				<rect x={-m.w / 2 - 6} y={-m.h / 2 - 3} width={m.w + 12} height={m.h + 6} rx={(m.h + 6) / 2} fill={SURFACE[theme].labelBg} stroke={SURFACE[theme].labelBorder} strokeWidth={1} />
				<Lines text={edge.label} x={0} y={0} size={12} weight={500} fill={SURFACE[theme].text} />
			</g>
		)
	}
	return (
		<g data-edge={edge.key} pointerEvents="none">
			<path d={roundedPolyline(line, 10)} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={dashArray} strokeLinecap="round" strokeLinejoin="round" />
			{hasEnd && <path d={arrowHead(approachPoint(pts, true), pts[pts.length - 1], 10)} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />}
			{hasStart && <path d={arrowHead(approachPoint(pts, false), pts[0], 10)} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />}
			{label}
		</g>
	)
})
