import { importText, printOcto, type Point } from '@octo-draw/core'
import { pushHistory, requestFit, setShapes, showToast, snapshot, uid, undo as undoLast, useStore } from '../store'
import { importImage } from './api'
import { screenToWorld, viewportSize } from '../canvas/camera'
import { makeMeasure } from './text'
import { sizeFor } from '../canvas/freehand'
import { insertImage } from './images'
import { pastePayload, payloadFromClipboard } from './clipboard'

const DIRECTIVE = /^\s*(title|direction|colorMode|styleMode|typeface)\b/

export interface ConvertedText {
	format: string
	code: string
	/** Layout hints that keep the source arrangement (ASCII imports), keyed by node key. */
	pins?: Record<string, Point>
	confidence?: number
	warnings: string[]
}

export function convertText(text: string): ConvertedText | null {
	const res = importText(text)
	if (!res || !res.ir.nodes.length) return null
	const warnings = res.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message)
	return { format: res.format, code: printOcto(res.ir), pins: res.pins, confidence: res.confidence, warnings }
}

/** Merges import pins into the document's pins: a replace starts from just these, an append overrides the imported keys. */
export function mergeImportPins(pins: Record<string, Point> | undefined, how: 'replace' | 'append') {
	const s = useStore.getState()
	if (how === 'replace') useStore.setState({ pins: pins ? { ...pins } : {} })
	else if (pins && Object.keys(pins).length) useStore.setState({ pins: { ...s.pins, ...pins } })
}

export function applyImportedCode(code: string, how: 'replace' | 'append', pins?: Record<string, Point>) {
	const s = useStore.getState()
	pushHistory(snapshot())
	if (how === 'replace' || !s.code.trim()) {
		useStore.setState({ code, selection: null })
		mergeImportPins(pins, 'replace')
	} else {
		const body = code
			.split('\n')
			.filter((l) => !DIRECTIVE.test(l))
			.join('\n')
			.trim()
		useStore.setState({ code: `${s.code.replace(/\s*$/, '')}\n\n// imported\n${body}\n` })
		mergeImportPins(pins, 'append')
	}
	setTimeout(requestFit, 250)
}

/** "Converted ASCII diagram · 92% confident · 1 warning" */
export function importMessage(what: string, r: { confidence?: number; warnings?: string[] }) {
	const parts = [what]
	if (typeof r.confidence === 'number') parts.push(`${Math.round(r.confidence * 100)}% confident`)
	const n = r.warnings?.length ?? 0
	if (n) parts.push(`${n} warning${n > 1 ? 's' : ''}`)
	return parts.join(' · ')
}

/** Toast action that lists the import warnings. */
export function warningsAction(warnings: string[] | undefined) {
	if (!warnings?.length) return []
	return [{ label: 'Show warnings', run: () => showToast(warnings.slice(0, 4).join(' · ') + (warnings.length > 4 ? ` · +${warnings.length - 4} more` : ''), [], 12000) }]
}

export const FORMAT_NAME: Record<string, string> = { mermaid: 'mermaid', ascii: 'ASCII', octo: 'octo code', plain: 'text' }

/**
 * Global paste (outside the editor): our own copies paste as shapes/nodes,
 * octo code appends, mermaid/ASCII convert, images become image shapes (with a
 * "Convert to diagram" toast for the vision flow), plain text becomes a text shape.
 */
export function handlePaste(e: ClipboardEvent) {
	const target = e.target as HTMLElement | null
	if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
	const dt = e.clipboardData
	if (!dt) return
	const own = payloadFromClipboard(dt)
	if (own) {
		e.preventDefault()
		pastePayload(own)
		return
	}
	const image = [...dt.files].find((f) => f.type.startsWith('image/'))
	if (image) {
		e.preventDefault()
		void insertImage(image).then((id) => {
			if (!id) {
				showToast("Couldn't read that image")
				return
			}
			showToast(
				'Image added to canvas',
				[
					{
						label: 'Convert to diagram',
						run: () => {
							setShapes(useStore.getState().shapes.filter((x) => x.id !== id))
							void importImage(image)
						},
					},
				],
				9000,
			)
		})
		return
	}
	const text = dt.getData('text/plain')
	if (!text.trim()) return
	e.preventDefault()
	const conv = convertText(text)
	if (conv && conv.format === 'octo' && useStore.getState().code.trim()) {
		// octo code from elsewhere (chat apps, another doc) appends
		applyImportedCode(conv.code, 'append', conv.pins)
		showToast('Pasted octo code: appended to the diagram', [{ label: 'Replace instead', run: () => (undoLast(), applyImportedCode(conv.code, 'replace', conv.pins)) }], 7000)
		return
	}
	if (conv && conv.format !== 'plain') {
		const empty = !useStore.getState().code.trim()
		const msg = importMessage(`Converted ${FORMAT_NAME[conv.format]} diagram`, conv)
		if (empty) {
			applyImportedCode(conv.code, 'replace', conv.pins)
			showToast(msg, warningsAction(conv.warnings), conv.warnings.length ? 9000 : undefined)
			return
		}
		showToast(
			msg,
			[
				{ label: 'Replace', run: () => applyImportedCode(conv.code, 'replace', conv.pins) },
				{ label: 'Append', run: () => applyImportedCode(conv.code, 'append', conv.pins) },
				...warningsAction(conv.warnings),
			],
			9000,
		)
		return
	}
	// plain text → a text shape in the middle of the view
	const { w, h, left, top } = viewportSize()
	const c = screenToWorld(left + w / 2, top + h / 2)
	const s = useStore.getState()
	const size = sizeFor('text', s.size)
	const m = makeMeasure('clean')(text, size)
	setShapes([
		...s.shapes,
		{ id: uid(), type: 'text', x: c.x - m.w / 2, y: c.y - m.h / 2, w: m.w, h: m.h, color: s.ink, size: s.size, text },
	])
}
