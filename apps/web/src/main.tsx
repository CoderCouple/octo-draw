import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentAction, ApplyResult, DiagramIR, DiagramLayout } from '@octo-draw/core'
import { App } from './App'
import { setCode, useStore } from './store'
import { startPipeline } from './lib/pipeline'
import { loadSaved, loadView, startPersistence } from './lib/persist'
import { setPage } from './lib/view'
import { ROOT_CRUMB } from './lib/pages'
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
			getPage: () => string
			setPage: (name: string) => boolean
		}
	}
}

loadSaved()
// `?example=sequence` (flowchart | architecture | sequence | erd) opens a starter diagram
const exampleId = new URLSearchParams(location.search).get('example')
const example = exampleId ? getExample(exampleId) : undefined
if (example) useStore.setState({ code: example.code, pins: {}, crumbs: [ROOT_CRUMB], page: '', collapsed: {} })
else loadView()
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
	getPage: () => useStore.getState().page,
	setPage: (name) => setPage(name, true),
}

// dev-only handle for headless tests
if (import.meta.env.DEV) (window as unknown as { __octoStore?: typeof useStore }).__octoStore = useStore

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
