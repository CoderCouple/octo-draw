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
	/** node key → page it drills into */
	drill?: Record<string, string>
	/** node key → expandable into a new page ('src': has a source ref, 'ai': AI only) */
	expandable?: Record<string, 'src' | 'ai'>
	/** node being expanded right now (loading shimmer) */
	expandingKey?: string | null
	/** show the hover "+" handles (add child / sibling) */
	composable?: boolean
}

const NO_DRILL: Record<string, string> = {}
const NO_EXPAND: Record<string, 'src' | 'ai'> = {}

export const DiagramLayer = memo(function DiagramLayer({ ir, layout, theme, selectedKey, editingKey, drill = NO_DRILL, expandable = NO_EXPAND, expandingKey = null, composable = false }: Props) {
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
				<linearGradient id="octo-shimmer" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">
					<stop offset="0" stopColor={SURFACE[theme].text} stopOpacity={0} />
					<stop offset="0.5" stopColor={SURFACE[theme].text} stopOpacity={theme === 'dark' ? 0.22 : 0.12} />
					<stop offset="1" stopColor={SURFACE[theme].text} stopOpacity={0} />
					<animateTransform attributeName="gradientTransform" type="translate" from="-1 0" to="1 0" dur="1.2s" repeatCount="indefinite" />
				</linearGradient>
				<filter id="octo-watercolor" x="-10%" y="-10%" width="120%" height="120%">
					<feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="3" result="noise" />
					<feDisplacementMap in="SourceGraphic" in2="noise" scale="4" />
				</filter>
			</defs>
			{groups.map((g) => {
				const node = byKey.get(g.key)
				return node ? (
					<GroupView key={g.key} iconsReady={iconsReady} node={node} box={g} mode={mode} theme={theme} selected={selectedKey === g.key} editing={editingKey === g.key} drillTo={drill[g.key]} composable={composable} />
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
						drillTo={drill[n.key]}
						expandable={expandable[n.key]}
						expanding={expandingKey === n.key}
						composable={composable}
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
	drillTo,
	expandable,
	expanding,
	composable,
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
	drillTo?: string
	expandable?: 'src' | 'ai'
	expanding?: boolean
	composable?: boolean
}) {
	const ghost = node.ext?.ghost === 'true'
	const collapsed = node.ext?.collapsed
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
	const fill = c.fill === 'none' ? SURFACE[theme].bg : c.fill
	const fillOpacity = c.fill === 'none' ? 0.001 : 1
	const strokeWidth = mode === 'outline' ? 2 : 1.5
	return (
		<g
			data-node={node.key}
			data-ghost={ghost ? '' : undefined}
			data-collapsed={collapsed}
			data-selected={selected ? '' : undefined}
			data-expanding={expanding ? '' : undefined}
			transform={`translate(${box.x},${box.y})`}
			style={{ cursor: 'pointer', transform: `translate(${box.x}px, ${box.y}px)` }}
			opacity={ghost ? 0.55 : undefined}
		>
			{collapsed !== undefined && (
				<>
					{/* stacked cards: the group's contents tucked behind */}
					<path d={roundedRect(box.w, box.h, 10)} transform="translate(8,8)" fill={fill} stroke={c.stroke} strokeWidth={1.2} opacity={0.55} />
					<path d={roundedRect(box.w, box.h, 10)} transform="translate(4,4)" fill={fill} stroke={c.stroke} strokeWidth={1.2} opacity={0.8} />
				</>
			)}
			<path
				d={collapsed !== undefined ? roundedRect(box.w, box.h, 10) : d}
				fill={ghost ? SURFACE[theme].bg : fill}
				fillOpacity={ghost ? 0.6 : fillOpacity}
				stroke={c.stroke}
				strokeWidth={strokeWidth}
				strokeDasharray={ghost ? '5 4' : undefined}
				filter={ghost ? undefined : filter}
			/>
			{detail && collapsed === undefined && <path d={detail} fill="none" stroke={c.stroke} strokeWidth={1.5} strokeDasharray={ghost ? '5 4' : undefined} />}
			{content}
			{collapsed !== undefined && <Chevron x={6} y={6} open={false} color={c.text} groupKey={node.key} />}
			{collapsed !== undefined && <CountBadge x={box.w} y={0} count={Number(collapsed) || 0} direct={node.ext?.children !== undefined ? Number(node.ext.children) : undefined} theme={theme} />}
			{drillTo !== undefined && !ghost && <DrillMark x={box.w - 18} y={box.h - 18} color={c.icon} target={drillTo} nodeKey={node.key} />}
			{drillTo === undefined && expandable && !ghost && <ExpandMark x={box.w - 18} y={box.h - 18} color={c.icon} kind={expandable} nodeKey={node.key} />}
			{expanding && <path data-export="skip" d={roundedRect(box.w, box.h, 10)} fill="url(#octo-shimmer)" stroke={c.stroke} strokeWidth={1.5} strokeDasharray="4 4" className="octo-expanding" pointerEvents="none" />}
			{composable && !ghost && <AddHandles w={box.w} h={box.h} nodeKey={node.key} theme={theme} />}
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
	drillTo,
	composable,
}: {
	iconsReady: number
	node: IRNode
	box: LaidOutNode
	mode: DiagramIR['style']['colorMode']
	theme: Theme
	selected: boolean
	editing: boolean
	drillTo?: string
	composable?: boolean
}) {
	const c = groupColors(node.style?.color, mode, theme)
	const label = node.label ?? node.key
	const chevron = 18
	const iconOffset = (node.icon ? 22 : 0) + chevron
	return (
		<g data-node={node.key} data-group="" data-selected={selected ? '' : undefined} transform={`translate(${box.x},${box.y})`} style={{ transform: `translate(${box.x}px, ${box.y}px)` }}>
			<path d={roundedRect(box.w, box.h, 12)} fill={c.fill === 'none' ? SURFACE[theme].bg : c.fill} fillOpacity={c.fill === 'none' ? 0.001 : 1} stroke={c.stroke} strokeWidth={1.2} strokeDasharray={node.style?.dash === 'dotted' || node.ext?.dash === 'dotted' ? '4 4' : undefined} />
			<g data-group-header="" style={{ cursor: 'pointer' }}>
				<rect x={0} y={0} width={box.w} height={36} fill="transparent" />
				<Chevron x={8} y={11} open color={c.text} groupKey={node.key} />
				{node.icon && <IconGlyph name={node.icon} x={14 + chevron} y={11} size={16} color={c.text} brand={node.style?.color === 'brand'} surface={c.fill === 'none' ? SURFACE[theme].bg : c.fill} />}
				{!editing && (
					<text x={14 + iconOffset} y={19} fontSize={13} fontWeight={600} fill={c.text} dominantBaseline="central">
						{label}
					</text>
				)}
				{drillTo !== undefined && <DrillMark x={box.w - 24} y={10} color={c.text} target={drillTo} nodeKey={node.key} />}
			</g>
			{selected && <path data-export="skip" d={roundedRect(box.w + 8, box.h + 8, 14)} transform="translate(-4,-4)" fill="none" stroke={SURFACE[theme].select} strokeWidth={1.5} strokeDasharray="5 4" />}
			{composable && <AddHandles w={box.w} h={box.h} nodeKey={node.key} theme={theme} group />}
		</g>
	)
})

/**
 * Hover "+" handles: bottom edge adds a child inside the node (a leaf becomes
 * a container), the right edge adds a sibling next to it.
 */
function AddHandles({ w, h, nodeKey, theme, group }: { w: number; h: number; nodeKey: string; theme: Theme; group?: boolean }) {
	const s = SURFACE[theme]
	const plus = (x: number, y: number, kind: 'child' | 'sibling', title: string) => (
		<g data-add={kind} data-add-key={nodeKey} transform={`translate(${x},${y})`} className="octo-add" style={{ cursor: 'copy' }}>
			<title>{title}</title>
			<circle r={11} fill="transparent" />
			<circle r={8} fill={s.bg} stroke={s.text} strokeWidth={1.2} />
			<path d="M-3.5,0 H3.5 M0,-3.5 V3.5" stroke={s.text} strokeWidth={1.5} strokeLinecap="round" />
		</g>
	)
	return (
		<g data-export="skip">
			{plus(w / 2, h, 'child', group ? 'Add a component inside (Tab)' : 'Add a component inside: makes this a container (Tab)')}
			{plus(w, group ? 18 : h / 2, 'sibling', 'Add a sibling next to it (Enter after naming)')}
		</g>
	)
}

/** Collapse/expand toggle on a group header (open) or a collapsed group node (closed). */
function Chevron({ x, y, open, color, groupKey }: { x: number; y: number; open: boolean; color: string; groupKey: string }) {
	return (
		<g data-chevron={groupKey} data-export="skip" transform={`translate(${x},${y})`} style={{ cursor: 'pointer' }}>
			<title>{open ? 'Collapse group' : 'Expand group'}</title>
			<rect x={-3} y={-3} width={20} height={20} rx={5} fill="transparent" className="octo-chevron-hit" />
			<path d={open ? 'M3.5,5.5 L7,9 L10.5,5.5' : 'M5.5,3.5 L9,7 L5.5,10.5'} transform="translate(0,0)" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="octo-chevron" />
		</g>
	)
}

function CountBadge({ x, y, count, direct, theme }: { x: number; y: number; count: number; direct?: number; theme: Theme }) {
	const s = SURFACE[theme]
	// nested: "<direct> · <all descendants>", flat: just the count
	const text = direct !== undefined && direct !== count ? `${direct} · ${count}` : String(count)
	const w = Math.max(20, 10 + text.length * 7)
	return (
		<g transform={`translate(${x - w / 2},${y - 10})`} pointerEvents="none">
			<title>{direct !== undefined ? `${direct} inside, ${count} in total` : `${count} inside`}</title>
			<rect width={w} height={20} rx={10} fill={s.text} />
			<text x={w / 2} y={10} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill={s.bg}>
				{text}
			</text>
		</g>
	)
}

/** The "↘" corner mark on nodes that drill into a sub-page. */
function DrillMark({ x, y, color, target, nodeKey }: { x: number; y: number; color: string; target: string; nodeKey: string }) {
	return (
		<g data-drill={nodeKey} data-export="skip" transform={`translate(${x},${y})`} style={{ cursor: 'zoom-in' }} className="octo-drill">
			<title>{`Open "${target}" (double-click)`}</title>
			<rect x={-2} y={-2} width={16} height={16} rx={4} fill={color} fillOpacity={0.08} />
			<path d="M3,3 L9.5,9.5 M9.5,4 L9.5,9.5 L4,9.5" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
		</g>
	)
}

/** Dotted "↘" on nodes without a page yet: expand into one (from source, or with AI). */
function ExpandMark({ x, y, color, kind, nodeKey }: { x: number; y: number; color: string; kind: 'src' | 'ai'; nodeKey: string }) {
	return (
		<g data-expand={nodeKey} data-export="skip" transform={`translate(${x},${y})`} style={{ cursor: 'zoom-in' }} className={`octo-expand ${kind}`}>
			<title>{kind === 'src' ? 'Expand from source into a sub-diagram (double-click)' : 'Expand into a sub-diagram with AI'}</title>
			<rect x={-2} y={-2} width={16} height={16} rx={4} fill={color} fillOpacity={0.06} stroke={color} strokeOpacity={0.5} strokeWidth={1} strokeDasharray="2 2" />
			<path d="M3,3 L9.5,9.5 M9.5,4 L9.5,9.5 L4,9.5" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 1.6" />
		</g>
	)
}

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
