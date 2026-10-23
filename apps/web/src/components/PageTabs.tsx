import { Plus } from 'lucide'
import { useStore } from '../store'
import { Icon } from './Icon'
import { newPage, setPage } from '../lib/view'

/** One tab per page (root first) above the editor, plus "+ page". */
export function PageTabs() {
	const names = useStore((s) => s.pageNames)
	const page = useStore((s) => s.page)
	const rootTitle = useStore((s) => s.rootTitle)
	return (
		<div className="page-tabs" role="tablist" aria-label="Pages">
			{names.map((name) => (
				<button
					key={name || '\u0000root'}
					role="tab"
					aria-selected={name === page}
					className={`page-tab${name === page ? ' on' : ''}${name ? '' : ' root'}`}
					title={name ? `page ${name}` : 'Root page'}
					onClick={() => setPage(name, true)}
				>
					{name || rootTitle || 'Root'}
				</button>
			))}
			<button className="page-tab add" onClick={newPage} title="Add a page (a sub-diagram nodes can drill into)">
				<Icon icon={Plus} size={13} />
				page
			</button>
		</div>
	)
}
