import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentAction, ApplyResult, DiagramIR, DiagramLayout } from '@octo-draw/core'
import { App } from './App'
import { setCode, useStore } from './store'
import { startPipeline } from './lib/pipeline'
import { loadSaved, startPersistence } from './lib/persist'
import { startSync } from './lib/sync'
import { loadIcons } from './lib/icons'
import { runActions } from './lib/actions'
import { getExample } from './examples'
import './styles.css'

declare global {
	interface Window {
		octo: {
			getCode: () => string
			setCode: (code: string) => void
			applyActions: (actions: AgentAction[]) => ApplyResult
			getIR: () => DiagramIR | null
			getLayout: () => DiagramLayout | null
		}
	}
}

loadSaved()
// `?example=sequence` (flowchart | architecture | sequence | erd) opens a starter diagram
const exampleId = new URLSearchParams(location.search).get('example')
const example = exampleId ? getExample(exampleId) : undefined
if (example) useStore.setState({ code: example.code, pins: {} })
startPipeline()
startPersistence()
// an example link is a local preview: do not pull (or overwrite) the shared server doc
if (!example) startSync()
void loadIcons()

window.octo = {
	getCode: () => useStore.getState().code,
	setCode: (code) => setCode(code),
	applyActions: (actions) => runActions(actions),
	getIR: () => useStore.getState().ir,
	getLayout: () => useStore.getState().layout,
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
