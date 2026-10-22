import { useEffect, useRef } from 'react'
import { Annotation, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { linter, lintGutter, type Diagnostic as CMDiagnostic } from '@codemirror/lint'
import { detectFormat, importText, parseOcto, printOcto } from '@octo-draw/core'
import { octoHighlight, octoLanguage } from './language'
import { octoCompletions } from './completion'
import { redo, setCode, showToast, undo, useStore } from '../store'

const External = Annotation.define<boolean>()

const setSelectedLine = StateEffect.define<number | null>()
const selectedLineField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes)
		for (const e of tr.effects) {
			if (e.is(setSelectedLine)) {
				if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) deco = Decoration.none
				else {
					const line = tr.state.doc.line(e.value)
					deco = Decoration.set([Decoration.line({ class: 'cm-octo-selected' }).range(line.from)])
				}
			}
		}
		return deco
	},
	provide: (f) => EditorView.decorations.from(f),
})

const octoLinter = linter(
	(view) => {
		const src = view.state.doc.toString()
		if (useStore.getState().aiBusy) return []
		const len = src.length
		return parseOcto(src).diagnostics.map(
			(d): CMDiagnostic => {
				const from = Math.max(0, Math.min(len, d.from))
				const to = Math.max(from, Math.min(len, d.to))
				return { from, to, severity: d.severity, message: d.message }
			},
		)
	},
	{ delay: 250 },
)

/** Pasting mermaid or ASCII art straight into the editor converts it to octo code. */
const convertingPaste = EditorView.domEventHandlers({
	paste(event, view) {
		const text = event.clipboardData?.getData('text/plain')
		if (!text) return false
		const fmt = detectFormat(text)
		if (fmt !== 'mermaid' && fmt !== 'ascii') return false
		const res = importText(text)
		if (!res || !res.ir.nodes.length) return false
		event.preventDefault()
		const code = printOcto(res.ir)
		const blank = !view.state.doc.toString().trim()
		const sel = view.state.selection.main
		view.dispatch(
			blank
				? { changes: { from: 0, to: view.state.doc.length, insert: code } }
				: { changes: { from: sel.from, to: sel.to, insert: code }, selection: { anchor: sel.from + code.length } },
		)
		showToast(`Converted ${fmt} → octo code`, [
			{
				label: 'Paste raw instead',
				run: () => {
					undo()
					const v = view.state.selection.main
					view.dispatch({ changes: { from: v.from, to: v.to, insert: text } })
				},
			},
		])
		return true
	},
})

const theme = EditorView.theme({
	'&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--card)', color: 'var(--foreground)' },
	'.cm-scroller': { fontFamily: 'var(--font-family-mono)', lineHeight: '1.65' },
	'.cm-content': { caretColor: 'var(--foreground-strong)', padding: '10px 0' },
	'.cm-gutters': { backgroundColor: 'var(--card)', color: 'var(--foreground-subtle)', border: 'none', paddingLeft: '6px' },
	'.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--muted) 60%, transparent)' },
	'.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted-foreground)' },
	'.cm-octo-selected': { backgroundColor: 'var(--highlight) !important', boxShadow: 'inset 2px 0 0 var(--foreground-strong)' },
	'&.cm-focused': { outline: 'none' },
	'.cm-cursor': { borderLeftColor: 'var(--foreground-strong)', borderLeftWidth: '2px' },
	'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
	'.cm-tooltip': { backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
	'.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px' },
	'.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' },
	'.cm-completionDetail': { opacity: 0.6, marginLeft: '8px', fontStyle: 'normal' },
	'.cm-diagnostic': { padding: '4px 8px' },
	'.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--destructive)', textUnderlineOffset: '3px' },
})

/** Minimal change between two strings (common prefix/suffix), so remote edits keep the cursor. */
function diff(a: string, b: string) {
	let start = 0
	const max = Math.min(a.length, b.length)
	while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++
	let endA = a.length
	let endB = b.length
	while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
		endA--
		endB--
	}
	return { from: start, to: endA, insert: b.slice(start, endB) }
}

export function Editor() {
	const host = useRef<HTMLDivElement>(null)
	const viewRef = useRef<EditorView | null>(null)

	useEffect(() => {
		const extensions: Extension[] = [
			lineNumbers(),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			drawSelection(),
			indentOnInput(),
			bracketMatching(),
			closeBrackets(),
			octoLanguage,
			octoHighlight,
			octoLinter,
			lintGutter(),
			autocompletion({ override: [octoCompletions], icons: false }),
			selectedLineField,
			convertingPaste,
			placeholder('Describe your diagram in code… e.g.  Users > API > DB'),
			keymap.of([
				{ key: 'Mod-z', run: () => (undo(), true), preventDefault: true },
				{ key: 'Mod-Shift-z', run: () => (redo(), true), preventDefault: true },
				{ key: 'Mod-y', run: () => (redo(), true), preventDefault: true },
				...closeBracketsKeymap,
				...completionKeymap,
				...defaultKeymap,
				indentWithTab,
			]),
			EditorState.tabSize.of(2),
			theme,
			EditorView.lineWrapping,
			EditorView.updateListener.of((u) => {
				if (!u.docChanged || u.transactions.some((tr) => tr.annotation(External))) return
				setCode(u.state.doc.toString(), { tag: 'type', ms: 1000 })
			}),
		]
		const view = new EditorView({
			state: EditorState.create({ doc: useStore.getState().code, extensions }),
			parent: host.current!,
		})
		viewRef.current = view

		const unsub = useStore.subscribe((s, prev) => {
			if (s.code !== prev.code) {
				const cur = view.state.doc.toString()
				if (cur !== s.code) {
					const change = diff(cur, s.code)
					view.dispatch({ changes: change, annotations: External.of(true) })
				}
			}
			if (s.selection !== prev.selection || s.ir !== prev.ir) {
				const key = s.selection?.kind === 'node' ? s.selection.key : null
				const node = key ? s.ir?.nodes.find((n) => n.key === key) : null
				const line = node?.span?.line ?? null
				const effects: StateEffect<unknown>[] = [setSelectedLine.of(line)]
				if (line && s.selection !== prev.selection && line <= view.state.doc.lines) {
					effects.push(EditorView.scrollIntoView(view.state.doc.line(line).from, { y: 'nearest' }))
				}
				view.dispatch({ effects })
			}
		})
		return () => {
			unsub()
			view.destroy()
		}
	}, [])

	return <div className="editor-host" ref={host} />
}
