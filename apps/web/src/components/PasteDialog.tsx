import { useEffect, useMemo, useRef, useState } from 'react'
import { detectFormat } from '@octo-draw/core'
import { X } from 'lucide'
import { Icon } from './Icon'
import { FORMAT_NAME, applyImportedCode, convertText, importMessage, warningsAction } from '../lib/importing'
import { showToast } from '../store'

const SAMPLE = `flowchart LR
  A[Browser] --> B{Logged in?}
  B -- yes --> C[Dashboard]
  B -- no --> D[Login page]`

export function PasteDialog({ onClose }: { onClose: () => void }) {
	const [text, setText] = useState('')
	const ref = useRef<HTMLTextAreaElement>(null)
	useEffect(() => ref.current?.focus(), [])
	const format = useMemo(() => (text.trim() ? detectFormat(text) : null), [text])
	const conv = useMemo(() => (text.trim() ? convertText(text) : null), [text])

	const apply = (how: 'replace' | 'append') => {
		if (!conv) {
			showToast('Could not find a diagram in that text')
			return
		}
		applyImportedCode(conv.code, how, conv.pins)
		showToast(importMessage(`Converted ${FORMAT_NAME[conv.format] ?? conv.format} diagram`, conv), warningsAction(conv.warnings), conv.warnings.length ? 9000 : undefined)
		onClose()
	}

	return (
		<div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="modal" role="dialog" aria-label="Import text diagram" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
				<div className="modal-head">
					<div>
						<h2>Import a text diagram</h2>
						<p>Paste mermaid, ASCII / box-drawing art from ChatGPT or Gemini, or octo code.</p>
					</div>
					<button className="icon-btn" onClick={onClose} aria-label="Close">
						<Icon icon={X} size={16} />
					</button>
				</div>
				<textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder={SAMPLE} spellCheck={false} />
				<div className="modal-foot">
					<span className="muted">
						{format ? (
							<>
								Detected: <b>{format}</b>
								{conv ? ` · ${conv.code.split('\n').filter(Boolean).length} lines of octo` : ' · nothing to convert'}
								{conv && typeof conv.confidence === 'number' ? ` · ${Math.round(conv.confidence * 100)}% confident` : ''}
								{conv?.warnings.length ? ` · ${conv.warnings.length} warning${conv.warnings.length > 1 ? 's' : ''}` : ''}
							</>
						) : (
							'Tip: you can also paste straight onto the canvas or into the editor.'
						)}
					</span>
					<div className="row">
						<button className="btn" disabled={!conv} onClick={() => apply('append')}>
							Append
						</button>
						<button className="btn primary" disabled={!conv} onClick={() => apply('replace')}>
							Replace diagram
						</button>
					</div>
				</div>
			</div>
		</div>
	)
}
