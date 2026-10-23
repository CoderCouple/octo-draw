import { memo } from 'react'
import type { DiagramIR, DiagramLayout, IRNode, LaidOutNode, SequenceLayout } from '@octo-draw/core'
import { ICON_SIZE } from '@octo-draw/core/src/layout/sizing'
import { edgeColor, groupColors, mix, nodeColors, resolveColor, SURFACE, type Theme } from '../lib/colors'
import { useIcons } from '../lib/icons'
import { fontFor, makeMeasure } from '../lib/text'
import { IconGlyph } from './DiagramLayer'
import { arrowHead, roundedRect } from './geometry'

interface Props {
	ir: DiagramIR
	layout: DiagramLayout
	theme: Theme
	selectedKey: string | null
	editingKey: string | null
}

const NUM_W = 22

/** Sequence diagram: participant boxes (head + foot), lifelines, activations, block frames, notes, messages. */
export const SequenceLayer = memo(function SequenceLayer({ ir, layout, theme, selectedKey, editingKey }: Props) {
	useIcons((s) => s.version)
	const seq = layout.sequence!
	const s = SURFACE[theme]
	const measure = makeMeasure(ir.style.typeface)
	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	const mode = ir.style.colorMode
	const filter = ir.style.styleMode === 'shadow' ? 'url(#octo-seq-shadow)' : undefined
	return (
		<g data-layer="diagram" data-kind="sequence" fontFamily={fontFor(ir.style.typeface)}>
			<defs>
				<filter id="octo-seq-shadow" x="-20%" y="-20%" width="140%" height="160%">
					<feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#000000" floodOpacity={theme === 'dark' ? 0.5 : 0.08} />
				</filter>
			</defs>
			{seq.blocks.map((b, i) => (
				<BlockFrame key={`b${i}`} block={b} theme={theme} measure={measure} />
			))}
			{seq.lifelines.map((l) => (
				<line key={`l-${l.key}`} x1={l.x} y1={l.y1} x2={l.x} y2={l.y2} stroke={s.muted} strokeWidth={1.2} strokeDasharray="5 5" opacity={0.7} />
			))}
			{seq.activations.map((a, i) => {
				const c = nodeColors(byKey.get(a.key)?.style?.color, mode === 'bold' ? 'pastel' : mode, theme)
				return <rect key={`a${i}`} x={a.x - 5} y={a.y1} width={10} height={a.y2 - a.y1} rx={2} fill={c.fill === 'none' ? s.bg : c.fill} stroke={c.stroke} strokeWidth={1.2} />
			})}
			{seq.notes.map((n, i) => {
				const c = n.color ? nodeColors(n.color, 'pastel', theme) : { fill: s.groupFill, stroke: s.muted, text: s.text }
				const fold = 8
				return (
					<g key={`n${i}`} transform={`translate(${n.x},${n.y})`}>
						<path d={`M0,0 H${n.w - fold} L${n.w},${fold} V${n.h} H0 Z`} fill={c.fill === 'none' ? s.bg : c.fill} stroke={c.stroke} strokeWidth={1} />
						<path d={`M${n.w - fold},0 V${fold} H${n.w}`} fill="none" stroke={c.stroke} strokeWidth={1} />
						<MultiLine text={n.text} x={n.w / 2} y={n.h / 2} size={12} fill={c.text} />
					</g>
				)
			})}
			{seq.messages.map((m) => (
				<Message key={`m${m.index}`} m={m} theme={theme} measure={measure} />
			))}
			{seq.participants.map((p) => {
				const node = byKey.get(p.key) ?? { key: p.key }
				const box = layout.nodes[p.key]
				if (!box) return null
				return (
					<g key={`p-${p.key}`}>
						<Participant node={node} box={box} theme={theme} mode={mode} filter={filter} selected={selectedKey === p.key} editing={editingKey === p.key} measure={measure} />
						<Participant node={node} box={{ ...box, y: p.footY }} theme={theme} mode={mode} filter={filter} selected={false} editing={false} measure={measure} foot />
					</g>
				)
			})}
		</g>
	)
})

type Measure = (t: string, size: number) => { w: number; h: number }

function MultiLine({ text, x, y, size, fill, weight = 500, anchor = 'middle' }: { text: string; x: number; y: number; size: number; fill: string; weight?: number; anchor?: 'middle' | 'start' }) {
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

function Participant({
	node,
	box,
	theme,
	mode,
	filter,
	selected,
	editing,
	measure,
	foot,
}: {
	node: IRNode
	box: LaidOutNode
	theme: Theme
	mode: DiagramIR['style']['colorMode']
	filter?: string
	selected: boolean
	editing: boolean
	measure: Measure
	foot?: boolean
}) {
	const c = nodeColors(node.style?.color, mode, theme)
	const s = SURFACE[theme]
	const label = node.label ?? node.key
	const tw = measure(label, 14).w
	const total = node.icon ? ICON_SIZE + 8 + tw : tw
	const sx = box.w / 2 - total / 2
	return (
		<g data-node={foot ? undefined : node.key} transform={`translate(${box.x},${box.y})`} style={{ cursor: 'pointer' }}>
			<path d={roundedRect(box.w, box.h, 8)} fill={c.fill === 'none' ? s.bg : c.fill} fillOpacity={c.fill === 'none' ? 0.001 : 1} stroke={c.stroke} strokeWidth={mode === 'outline' ? 2 : 1.5} filter={filter} />
			{node.icon && <IconGlyph name={node.icon} x={sx} y={box.h / 2 - ICON_SIZE / 2} size={ICON_SIZE} color={c.icon} brand={node.style?.color === 'brand'} surface={c.fill === 'none' ? s.bg : c.fill} />}
			{!editing && (
				<text x={node.icon ? sx + ICON_SIZE + 8 : box.w / 2} y={box.h / 2} textAnchor={node.icon ? 'start' : 'middle'} fontSize={14} fontWeight={500} fill={c.text} dominantBaseline="central">
					{label}
				</text>
			)}
			{selected && <path data-export="skip" d={roundedRect(box.w + 8, box.h + 8, 10)} transform="translate(-4,-4)" fill="none" stroke={s.select} strokeWidth={1.5} strokeDasharray="5 4" />}
		</g>
	)
}

function Message({ m, theme, measure }: { m: SequenceLayout['messages'][number]; theme: Theme; measure: Measure }) {
	const s = SURFACE[theme]
	const color = edgeColor(m.color, theme)
	const dash = m.dash === 'dotted' ? '6 5' : undefined
	const hasEnd = m.arrow.end === 'arrow'
	const hasStart = m.arrow.start === 'arrow'
	let line: string
	const heads: string[] = []
	if (m.self) {
		const y2 = m.y2 ?? m.y + 22
		const r = m.x1 + 34
		line = `M${m.x1},${m.y} H${r - 6} Q${r},${m.y} ${r},${m.y + 6} V${y2 - 6} Q${r},${y2} ${r - 6},${y2} H${m.x1 + (hasEnd ? 8 : 0)}`
		if (hasEnd) heads.push(arrowHead({ x: m.x1 + 20, y: y2 }, { x: m.x1, y: y2 }, 9))
	} else {
		const dir = Math.sign(m.x2 - m.x1) || 1
		const a = m.x1 + (hasStart ? dir * 8 : 0)
		const b = m.x2 - (hasEnd ? dir * 8 : 0)
		line = `M${a},${m.y} H${b}`
		if (hasEnd) heads.push(arrowHead({ x: m.x1, y: m.y }, { x: m.x2, y: m.y }, 9))
		if (hasStart) heads.push(arrowHead({ x: m.x2, y: m.y }, { x: m.x1, y: m.y }, 9))
	}
	let label = null
	if (m.labelAt && (m.label || m.number !== undefined)) {
		const lw = m.label ? measure(m.label, 12) : { w: 0, h: 14 }
		const total = lw.w + (m.number !== undefined ? NUM_W : 0)
		const left = m.labelAt.x - total / 2
		label = (
			<g>
				<rect x={left - 4} y={m.labelAt.y - lw.h / 2 - 1} width={total + 8} height={lw.h + 2} rx={4} fill={s.bg} opacity={0.85} />
				{m.number !== undefined && (
					<>
						<circle cx={left + 8} cy={m.labelAt.y} r={8} fill={color} />
						<text x={left + 8} y={m.labelAt.y} textAnchor="middle" dominantBaseline="central" fontSize={9.5} fontWeight={700} fill={s.bg}>
							{m.number}
						</text>
					</>
				)}
				{m.label && <MultiLine text={m.label} x={left + (m.number !== undefined ? NUM_W : 0)} y={m.labelAt.y} size={12} fill={s.text} anchor="start" />}
			</g>
		)
	}
	return (
		<g data-message={m.index} pointerEvents="none">
			<path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={dash} strokeLinecap="round" />
			{heads.map((d, i) => (
				<path key={i} d={d} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />
			))}
			{label}
		</g>
	)
}

function BlockFrame({ block, theme, measure }: { block: SequenceLayout['blocks'][number]; theme: Theme; measure: Measure }) {
	const s = SURFACE[theme]
	const tint = resolveColor(block.color)
	const g = groupColors(block.color, undefined, theme)
	const stroke = tint ? g.stroke : s.muted
	const text = tint ? g.text : s.groupText
	const tabFill = tint ? g.fill : s.groupFill
	const kw = block.type
	const kwW = measure(kw, 11).w + 16
	const tabH = 20
	const first = block.sections[0]
	return (
		<g data-block={block.type} pointerEvents="none">
			<rect x={block.x} y={block.y} width={block.w} height={block.h} rx={6} fill={tint ? mix(tabFill, s.bg, 0.5) : 'none'} fillOpacity={tint ? 0.6 : 1} stroke={stroke} strokeWidth={1.2} />
			<path d={`M${block.x + 6},${block.y} H${block.x + kwW} V${block.y + tabH - 6} L${block.x + kwW - 6},${block.y + tabH} H${block.x} V${block.y + 6} Q${block.x},${block.y} ${block.x + 6},${block.y} Z`} fill={tabFill} stroke={stroke} strokeWidth={1.2} />
			<text x={block.x + 8} y={block.y + tabH / 2} fontSize={11} fontWeight={700} fill={text} dominantBaseline="central">
				{kw}
			</text>
			{first?.label && (
				<text x={block.x + kwW + 10} y={block.y + tabH / 2} fontSize={12} fontWeight={500} fill={text} dominantBaseline="central">
					[{first.label}]
				</text>
			)}
			{block.sections.slice(1).map((sec, i) => (
				<g key={i}>
					<line x1={block.x} y1={sec.y} x2={block.x + block.w} y2={sec.y} stroke={stroke} strokeWidth={1.1} strokeDasharray="6 4" />
					{sec.label && (
						<text x={block.x + 10} y={sec.y + 13} fontSize={12} fontWeight={500} fill={text} dominantBaseline="central">
							[{sec.label}]
						</text>
					)}
				</g>
			))}
		</g>
	)
}
