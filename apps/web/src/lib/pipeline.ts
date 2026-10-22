import { parseOcto, type DiagramIR, type DiagramLayout } from '@octo-draw/core'
import { applyPins } from '@octo-draw/core/src/layout/pins'
import { useStore } from '../store'
import { layoutInWorker } from './layoutClient'

let base: DiagramLayout | null = null
let baseIR: DiagramIR | null = null
let run = 0
let timer: ReturnType<typeof setTimeout> | undefined
let firstLayout = true

/** Code → parse → ELK layout (debounced), pins applied on top. Keeps the last good layout on errors. */
export function startPipeline() {
	const relayout = async () => {
		const s = useStore.getState()
		const id = ++run
		let src = s.code
		// while the AI streams, ignore the trailing partial line
		if (s.aiBusy && !src.endsWith('\n')) src = src.slice(0, src.lastIndexOf('\n') + 1)
		const { ir, diagnostics } = parseOcto(src)
		const hasError = diagnostics.some((d) => d.severity === 'error')
		useStore.setState({ diagnostics: s.aiBusy ? [] : diagnostics })
		if (hasError && base) {
			useStore.setState({ layoutPending: false })
			return
		}
		try {
			const layout = await layoutInWorker(ir)
			if (id !== run) return
			base = layout
			baseIR = ir
			useStore.setState({ ir, layout: applyPins(ir, layout, useStore.getState().pins), layoutPending: false })
			if (firstLayout) {
				firstLayout = false
				useStore.setState({ fitRequest: useStore.getState().fitRequest + 1, fitStrict: false })
			}
		} catch (err) {
			console.warn('layout failed', err)
			if (id === run) useStore.setState({ layoutPending: false })
		}
	}

	const schedule = (ms: number) => {
		clearTimeout(timer)
		useStore.setState({ layoutPending: true })
		timer = setTimeout(relayout, ms)
	}

	useStore.subscribe((s, prev) => {
		if (s.code !== prev.code || (prev.aiBusy && !s.aiBusy)) schedule(firstLayout ? 0 : 150)
		else if (s.pins !== prev.pins && base && baseIR) {
			useStore.setState({ layout: applyPins(baseIR, base, s.pins) })
		}
	})
	schedule(0)
}
