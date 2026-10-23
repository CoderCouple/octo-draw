import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Minus, Plus, Upload, X } from 'lucide'
import { Icon } from './Icon'
import { pushHistory, requestFit, showToast, useStore } from '../store'
import { ROOT_CRUMB } from '../lib/pages'
import { shortError } from '../lib/api'
import { STARTER } from '../starter'

const ANALYZERS = ['code', 'compose', 'k8s', 'terraform', 'openapi'] as const
type Analyzer = (typeof ANALYZERS)[number]

export type SourceKind = 'local' | 'github' | 'huggingface' | 'cloud' | 'unknown'

/** What kind of connector an input would hit (mirrors the server's resolveSource order). */
export function sourceKind(input: string): SourceKind {
	const s = input.trim()
	if (!s) return 'unknown'
	if (/^(aws|gcp|azure):/i.test(s)) return 'cloud'
	if (/^(hf:|huggingface\.co\/|https?:\/\/huggingface\.co\/)/i.test(s)) return 'huggingface'
	if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(s) || /^github:/i.test(s) || /^git@github\.com:/i.test(s) || /^[\w.-]+\/[\w.-]+(@[\w./-]+)?$/.test(s)) return 'github'
	if (/^(\/|~\/|\.\/|\.\.\/|file:\/\/|local:)/.test(s)) return 'local'
	return 'unknown'
}

interface ScanResponse {
	code?: string
	error?: string
	findings?: { analyzer: string; confidence: number; notes?: string[] }[]
	warnings?: string[]
}

/** Import → "Connect source…": scan a folder / repo / model / cloud inventory into a multi-page diagram. */
export function ConnectSourceDialog({ onClose }: { onClose: () => void }) {
	const [source, setSource] = useState('')
	const [depth, setDepth] = useState(1)
	const [only, setOnly] = useState<Set<Analyzer>>(new Set())
	const [inventory, setInventory] = useState<{ name: string; data: unknown } | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState<{ code: string; message: string } | null>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const fileRef = useRef<HTMLInputElement>(null)
	const abort = useRef<AbortController | null>(null)
	useEffect(() => inputRef.current?.focus(), [])
	useEffect(() => () => abort.current?.abort(), [])
	const kind = sourceKind(source)

	const open = (code: string, message: string) => {
		pushHistory()
		const prev = useStore.getState().layout
		useStore.setState({ code, pins: {}, selection: null, crumbs: [ROOT_CRUMB], page: '', collapsed: {} })
		const unsub = useStore.subscribe((s) => {
			if (s.layout === prev) return
			unsub()
			requestFit()
		})
		setTimeout(unsub, 4000)
		showToast(message, undefined, 10000)
		onClose()
	}

	const run = async () => {
		if (!source.trim() || busy) return
		setBusy(true)
		setError(null)
		const ctrl = new AbortController()
		abort.current = ctrl
		try {
			const body: Record<string, unknown> = { source: source.trim(), depth }
			if (only.size) body.only = [...only]
			if (inventory) body.options = { export: inventory.data }
			const res = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
			const data = (await res.json().catch(() => ({ error: res.statusText }))) as ScanResponse
			if (!res.ok || !data.code) throw new Error(data.error ?? `scan failed (${res.status})`)
			const pages = data.code.split('\n').filter((l) => /^page\s/.test(l)).length + 1
			const findings = (data.findings ?? []).map((f) => `${f.analyzer} ${Math.round(f.confidence * 100)}%`).join(', ')
			const warnings = data.warnings ?? []
			const message = `Scanned ${source.trim()}: ${pages} page${pages > 1 ? 's' : ''}${findings ? ` · ${findings}` : ''}${warnings.length ? ` · ${warnings.length} warning${warnings.length > 1 ? 's' : ''}: ${warnings[0]}` : ''}`
			const cur = useStore.getState().code.trim()
			if (cur && cur !== STARTER.trim()) setPending({ code: data.code, message })
			else open(data.code, message)
		} catch (err) {
			if ((err as Error).name !== 'AbortError') setError(shortError(err))
		} finally {
			setBusy(false)
		}
	}

	const toggle = (a: Analyzer) =>
		setOnly((s) => {
			const next = new Set(s)
			if (next.has(a)) next.delete(a)
			else next.add(a)
			return next
		})

	return (
		<div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="modal connect" role="dialog" aria-label="Connect source" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
				<div className="modal-head">
					<div>
						<h2>Connect a source</h2>
						<p>Scan a folder, a GitHub repo, a Hugging Face model or a cloud account into a diagram with drill-down pages.</p>
					</div>
					<button className="icon-btn" onClick={onClose} aria-label="Close">
						<Icon icon={X} size={16} />
					</button>
				</div>
				<form
					className="connect-form"
					onSubmit={(e) => {
						e.preventDefault()
						void run()
					}}
				>
					<label className="field">
						<span>Source</span>
						<input ref={inputRef} value={source} onChange={(e) => setSource(e.target.value)} placeholder="~/code/my-app · github.com/owner/repo · hf:org/model · aws:" spellCheck={false} />
						<span className="muted small">
							{kind === 'local' && 'Local folder on this machine (must be under OCTO_SCAN_ROOTS)'}
							{kind === 'github' && 'GitHub repository (uses GITHUB_TOKEN / gh auth on the server if set)'}
							{kind === 'huggingface' && 'Hugging Face model'}
							{kind === 'cloud' && 'Live cloud account'}
							{kind === 'unknown' && (source.trim() ? 'Not sure what this is; the server will try every connector' : 'A path, a repo URL, hf:org/model, or aws: / gcp: / azure:')}
						</span>
					</label>
					{kind === 'cloud' && (
						<div className="connect-note">
							<b>Uses this machine's credentials, read-only.</b> The server lists resources with your local cloud profile and never writes. Or upload an exported inventory instead:
							<div className="row">
								<button type="button" className="btn small" onClick={() => fileRef.current?.click()}>
									<Icon icon={Upload} size={13} /> {inventory ? inventory.name : 'Upload inventory JSON…'}
								</button>
								{inventory && (
									<button type="button" className="icon-btn" onClick={() => setInventory(null)} aria-label="Remove inventory">
										<Icon icon={X} size={13} />
									</button>
								)}
							</div>
							<input
								ref={fileRef}
								type="file"
								accept="application/json,.json"
								hidden
								onChange={async (e) => {
									const f = e.target.files?.[0]
									e.target.value = ''
									if (!f) return
									try {
										setInventory({ name: f.name, data: JSON.parse(await f.text()) })
									} catch {
										setError(`${f.name} is not valid JSON`)
									}
								}}
							/>
						</div>
					)}
					<div className="connect-row">
						<div className="stepper" aria-label="Depth">
							<span>Depth</span>
							<button type="button" className="icon-btn" onClick={() => setDepth((d) => Math.max(1, d - 1))} disabled={depth <= 1} aria-label="Less depth">
								<Icon icon={Minus} size={13} />
							</button>
							<span className="stepper-value">{depth}</span>
							<button type="button" className="icon-btn" onClick={() => setDepth((d) => Math.min(5, d + 1))} disabled={depth >= 5} aria-label="More depth">
								<Icon icon={Plus} size={13} />
							</button>
							<span className="muted small">{depth === 1 ? 'root + one page per service' : `${depth} levels of pages`}</span>
						</div>
					</div>
					<fieldset className="connect-only">
						<legend className="muted small">Analyzers {only.size ? '' : '(all)'}</legend>
						{ANALYZERS.map((a) => (
							<label key={a} className="check">
								<input type="checkbox" checked={only.has(a)} onChange={() => toggle(a)} />
								{a}
							</label>
						))}
					</fieldset>
					{error && <div className="connect-error">{error}</div>}
					{pending ? (
						<div className="connect-confirm">
							<span>Replace the current diagram with the scan? (Undo brings it back.)</span>
							<div className="row">
								<button type="button" className="btn" onClick={() => setPending(null)}>
									Keep current
								</button>
								<button type="button" className="btn primary" onClick={() => open(pending.code, pending.message)}>
									Replace
								</button>
							</div>
						</div>
					) : (
						<div className="modal-foot">
							<span className="muted small">Secrets and env values are never read into the diagram.</span>
							<div className="row">
								<button type="button" className="btn" onClick={onClose}>
									Cancel
								</button>
								<button type="submit" className="btn primary" disabled={!source.trim() || busy}>
									{busy && <Icon icon={LoaderCircle} size={14} className="spin" />}
									{busy ? 'Scanning…' : 'Scan'}
								</button>
							</div>
						</div>
					)}
				</form>
			</div>
		</div>
	)
}
