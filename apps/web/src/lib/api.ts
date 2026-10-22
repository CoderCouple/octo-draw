import { pushHistory, requestFit, showToast, snapshot, useStore } from '../store'
import { endPresence, expectPresence } from './presence'

/** Reads `data: {...}` lines from a fetch Response body. */
export async function* sseEvents(res: Response): AsyncGenerator<Record<string, unknown>> {
	const reader = res.body!.getReader()
	const decoder = new TextDecoder()
	let buf = ''
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		buf += decoder.decode(value, { stream: true })
		let idx
		while ((idx = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, idx).replace(/\r$/, '')
			buf = buf.slice(idx + 1)
			if (!line.startsWith('data:')) continue
			const payload = line.slice(5).trim()
			if (!payload) continue
			try {
				yield JSON.parse(payload)
			} catch {
				// ignore malformed line
			}
		}
	}
}

let aborter: AbortController | null = null

export function cancelGenerate() {
	aborter?.abort()
}

/** POST /api/generate, streaming octo code into the editor live. One undo step. */
export async function generate(prompt: string, edit: boolean) {
	if (!prompt.trim()) return
	aborter?.abort()
	const ctrl = new AbortController()
	aborter = ctrl
	const start = useStore.getState()
	const original = start.code
	pushHistory(snapshot())
	useStore.setState({ aiBusy: edit ? 'AI is editing…' : 'AI is drawing…', selection: null })
	expectPresence('AI')
	let streamed = ''
	let gotDelta = false
	try {
		const res = await fetch('/api/generate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(edit ? { prompt, code: original } : { prompt }),
			signal: ctrl.signal,
		})
		if (!res.ok || !res.body) throw new Error(await res.text().catch(() => res.statusText))
		for await (const ev of sseEvents(res)) {
			if (typeof ev.delta === 'string') {
				streamed += ev.delta
				if (!gotDelta) {
					gotDelta = true
					useStore.setState({ pins: edit ? useStore.getState().pins : {} })
				}
				useStore.setState({ code: streamed })
			}
			if (typeof ev.error === 'string') throw new Error(ev.error)
			if (ev.done) {
				const code = typeof ev.code === 'string' ? ev.code : streamed
				useStore.setState({ code })
			}
		}
		if (!gotDelta && useStore.getState().code === original) showToast('The AI returned no diagram')
	} catch (err) {
		if ((err as Error).name !== 'AbortError') {
			showToast(`AI request failed: ${shortError(err)}`)
			if (!gotDelta) {
				// nothing streamed: drop the empty history step
				const s = useStore.getState()
				useStore.setState({ past: s.past.slice(0, -1) })
			}
		}
	} finally {
		if (aborter === ctrl) aborter = null
		useStore.setState({ aiBusy: null })
		endPresence()
		if (gotDelta) setTimeout(requestFit, 200)
	}
}

export function shortError(err: unknown) {
	let msg = err instanceof Error ? err.message : String(err)
	try {
		const parsed = JSON.parse(msg) as { error?: string }
		if (parsed.error) msg = parsed.error
	} catch {
		// not JSON
	}
	if (/Failed to fetch|NetworkError|ECONNREFUSED|502|504/i.test(msg)) return 'server not reachable (is apps/server running on :8787?)'
	return msg.slice(0, 140)
}

export function fileToBase64(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader()
		r.onload = () => resolve(String(r.result).replace(/^data:[^;]+;base64,/, ''))
		r.onerror = () => reject(r.error)
		r.readAsDataURL(file)
	})
}

/** POST /api/vision: image of a diagram → octo code (replaces the current diagram, undoable). */
export async function importImage(file: Blob) {
	useStore.setState({ aiBusy: 'AI is reading your image…' })
	try {
		const imageBase64 = await fileToBase64(file)
		const res = await fetch('/api/vision', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ imageBase64, mediaType: file.type || 'image/png' }),
		})
		if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
		const data = (await res.json()) as { code?: string; error?: string }
		if (!data.code) throw new Error(data.error ?? 'no code returned')
		pushHistory(snapshot())
		useStore.setState({ code: data.code, pins: {}, selection: null })
		showToast('Imported diagram from image')
		setTimeout(requestFit, 300)
	} catch (err) {
		showToast(`Image import failed: ${shortError(err)}`)
	} finally {
		useStore.setState({ aiBusy: null })
	}
}
