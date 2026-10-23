import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Ellipsis, Focus, Layers } from 'lucide'
import { useStore } from '../store'
import { Icon } from '../components/Icon'
import { crumbLabels, truncateCrumbs } from '../lib/pages'
import { goToCrumb } from '../lib/view'
import { nodeLabel } from '../lib/docModel'

/**
 * `Checkout › Payments flow › …` at the canvas top-left; clicking a crumb goes
 * back to it. Trails deeper than 4 levels fold their middle into a "…" menu.
 */
export function Breadcrumbs() {
	const crumbs = useStore((s) => s.crumbs)
	const title = useStore((s) => s.title)
	const rootTitle = useStore((s) => s.rootTitle)
	const code = useStore((s) => s.code)
	const pages = useStore((s) => s.pageNames.length)
	const [more, setMore] = useState(false)
	const moreRef = useRef<HTMLSpanElement>(null)
	useEffect(() => {
		if (!more) return
		const close = (e: PointerEvent) => {
			if (moreRef.current && e.target instanceof Node && !moreRef.current.contains(e.target)) setMore(false)
		}
		window.addEventListener('pointerdown', close, true)
		return () => window.removeEventListener('pointerdown', close, true)
	}, [more])
	if (crumbs.length <= 1 && pages <= 1) return null
	const labels = crumbLabels(crumbs, rootTitle || title, (page, key) => nodeLabel(code, page, key))
	const { shown, hidden } = truncateCrumbs(crumbs.length)
	const crumbButton = (i: number) => {
		const c = crumbs[i]
		const last = i === crumbs.length - 1
		return (
			<button
				className={`crumb${last ? ' on' : ''}`}
				disabled={last}
				aria-current={last ? 'page' : undefined}
				title={c.focus ? `Focus: ${labels[i]}` : c.page || 'Root page'}
				onClick={() => goToCrumb(i)}
			>
				{i === 0 && <Icon icon={Layers} size={13} />}
				{c.focus && <Icon icon={Focus} size={13} />}
				<span>{labels[i]}</span>
			</button>
		)
	}
	return (
		<nav className="crumbs" aria-label="Diagram path" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
			{shown.map((i, n) => (
				<span key={i === 'more' ? 'more' : i} className="crumb-wrap">
					{n > 0 && <Icon icon={ChevronRight} size={13} className="crumb-sep" />}
					{i === 'more' ? (
						<span className="menu" ref={moreRef}>
							<button className="crumb crumb-more" aria-label={`${hidden.length} more levels`} aria-expanded={more} title={`${hidden.length} more levels`} onClick={() => setMore((m) => !m)}>
								<Icon icon={Ellipsis} size={14} />
							</button>
							{more && (
								<div className="menu-pop crumb-menu" role="menu">
									{hidden.map((h, d) => (
										<button
											key={h}
											className="menu-item"
											style={{ paddingLeft: 9 + d * 12 }}
											onClick={() => {
												setMore(false)
												goToCrumb(h)
											}}
										>
											{crumbs[h].focus ? <Icon icon={Focus} size={13} /> : <Icon icon={ChevronRight} size={13} />}
											<span className="menu-label">{labels[h]}</span>
										</button>
									))}
								</div>
							)}
						</span>
					) : (
						crumbButton(i)
					)}
				</span>
			))}
			<span className="crumb-depth" title="Depth">
				{crumbs.length - 1 > 0 ? `L${crumbs.length - 1}` : ''}
			</span>
		</nav>
	)
}
