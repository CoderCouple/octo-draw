import { ChevronRight, Focus, Layers } from 'lucide'
import { useStore } from '../store'
import { Icon } from '../components/Icon'
import { crumbLabels } from '../lib/pages'
import { goToCrumb } from '../lib/view'

/** `Checkout › Payments flow` at the canvas top-left; clicking a crumb goes back to it. */
export function Breadcrumbs() {
	const crumbs = useStore((s) => s.crumbs)
	const title = useStore((s) => s.title)
	const rootTitle = useStore((s) => s.rootTitle)
	const ir = useStore((s) => s.ir)
	const pageIR = useStore((s) => s.pageIR)
	const pages = useStore((s) => s.pageNames.length)
	if (crumbs.length <= 1 && pages <= 1) return null
	const labelOf = (_page: string, key: string) => {
		const n = pageIR?.nodes.find((x) => x.key === key) ?? ir?.nodes.find((x) => x.key === key)
		return n?.label ?? key
	}
	const labels = crumbLabels(crumbs, rootTitle || title, labelOf)
	return (
		<nav className="crumbs" aria-label="Diagram path" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
			{crumbs.map((c, i) => {
				const last = i === crumbs.length - 1
				return (
					<span key={i} className="crumb-wrap">
						{i > 0 && <Icon icon={ChevronRight} size={13} className="crumb-sep" />}
						<button
							className={`crumb${last ? ' on' : ''}`}
							disabled={last}
							aria-current={last ? 'page' : undefined}
							title={last ? undefined : i === crumbs.length - 2 ? 'Back (Alt+↑)' : 'Back to here'}
							onClick={() => goToCrumb(i)}
						>
							{i === 0 && <Icon icon={Layers} size={13} />}
							{c.focus && <Icon icon={Focus} size={13} />}
							<span>{labels[i]}</span>
						</button>
					</span>
				)
			})}
		</nav>
	)
}
