import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, CircleAlert, ListTree, Pencil, Plus, Search, Trash2, X } from 'lucide'
import { useStore } from '../store'
import { Icon } from './Icon'
import { newPage, setPage } from '../lib/view'
import { buildOutline, outlineAncestors, type OutlineRow } from '../lib/outline'
import { addChildPage, deletePageNamed, renamePageTo } from '../lib/compose'
import { parsedPage } from '../lib/docModel'

const OPEN_KEY = 'octo-draw:outline:open'
const TOGGLED_KEY = 'octo-draw:outline:toggled'

function load<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key)
		return raw ? (JSON.parse(raw) as T) : fallback
	} catch {
		return fallback
	}
}
function save(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value))
	} catch {
		// private mode
	}
}

/**
 * The code panel's page navigator: a compact "current page" header and a
 * collapsible outline of the page tree (indentation = drill depth, search,
 * counts on closed branches, per-page actions).
 */
export function PageOutline() {
	const tree = useStore((s) => s.tree)
	const names = useStore((s) => s.pageNames)
	const page = useStore((s) => s.page)
	const depth = useStore((s) => s.crumbs.filter((c) => !c.focus).length - 1)
	const rootTitle = useStore((s) => s.rootTitle)
	const [open, setOpen] = useState(() => load(OPEN_KEY, names.length > 1))
	const [toggled, setToggled] = useState<Record<string, boolean>>(() => load(TOGGLED_KEY, {}))
	const [query, setQuery] = useState('')
	const listRef = useRef<HTMLDivElement>(null)

	useEffect(() => save(OPEN_KEY, open), [open])
	useEffect(() => save(TOGGLED_KEY, toggled), [toggled])
	// opening a page reveals it: re-open the branches above it
	useEffect(() => {
		const up = outlineAncestors(tree, page, names)
		if (up.some((id) => toggled[id] === false)) {
			setToggled((t) => {
				const next = { ...t }
				for (const id of up) delete next[id]
				return next
			})
		}
	}, [page, tree])
	useEffect(() => {
		listRef.current?.querySelector('.outline-row.on')?.scrollIntoView({ block: 'nearest' })
	}, [page, open])

	const rows = useMemo(() => buildOutline(tree, { pageNames: names, current: page, toggled, query, rootLabel: rootTitle || 'Root' }), [tree, names, page, toggled, query, rootTitle])
	const pageLabel = page ? page.split(' / ').pop() : rootTitle || 'Root'

	return (
		<div className={`page-outline${open ? ' open' : ''}`}>
			<div className="page-bar">
				<button className={`icon-btn${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} title={open ? 'Hide pages' : 'Show all pages'} aria-expanded={open} aria-label="Pages outline">
					<Icon icon={ListTree} size={15} />
				</button>
				<button className="page-current" onClick={() => setOpen(true)} title={page ? `page ${page}` : 'Root page'}>
					<span className="page-current-name">{pageLabel}</span>
					{depth > 0 && <span className="page-depth">L{depth}</span>}
				</button>
				<span className="muted small page-count">{names.length > 1 ? `${names.length} pages` : ''}</span>
				<button className="icon-btn" onClick={newPage} title="Add a page (a sub-diagram nodes can drill into)" aria-label="Add a page">
					<Icon icon={Plus} size={15} />
				</button>
			</div>
			{open && (
				<div className="outline">
					<label className="outline-search">
						<Icon icon={Search} size={13} />
						<input
							value={query}
							placeholder="Filter pages…"
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Escape') setQuery('')
								if (e.key === 'Enter') {
									const hit = rows.find((r) => r.page !== null && r.match)
									if (hit?.page !== null && hit) setPage(hit.page, true)
								}
							}}
						/>
						{query && (
							<button className="icon-btn" onClick={() => setQuery('')} aria-label="Clear filter">
								<Icon icon={X} size={12} />
							</button>
						)}
					</label>
					<div className="outline-rows" ref={listRef} role="tree" aria-label="Pages">
						{rows.map((r) => (
							<OutlineItem key={r.id} row={r} onToggle={() => setToggled((t) => ({ ...t, [r.id]: !r.open }))} />
						))}
						{!rows.length && <div className="outline-empty muted small">No page matches “{query}”</div>}
					</div>
				</div>
			)}
		</div>
	)
}

function OutlineItem({ row, onToggle }: { row: OutlineRow; onToggle: () => void }) {
	const [mode, setMode] = useState<'idle' | 'rename' | 'delete' | 'child'>('idle')
	const real = row.page !== null
	const label = row.match ? (
		<>
			{row.label.slice(0, row.match[0])}
			<mark>{row.label.slice(row.match[0], row.match[1])}</mark>
			{row.label.slice(row.match[1])}
		</>
	) : (
		row.label
	)
	return (
		<div className="outline-item" role="treeitem" aria-expanded={row.hasChildren ? row.open : undefined} aria-selected={row.current}>
			<div className={`outline-row${row.current ? ' on' : ''}${real ? '' : ' synthetic'}`} style={{ paddingLeft: 4 + row.depth * 14 }}>
				{row.hasChildren ? (
					<button className="outline-chevron" onClick={onToggle} aria-label={row.open ? 'Collapse' : 'Expand'}>
						<Icon icon={row.open ? ChevronDown : ChevronRight} size={13} />
					</button>
				) : (
					<span className="outline-chevron" />
				)}
				{mode === 'rename' && row.page ? (
					<input
						className="outline-rename"
						autoFocus
						defaultValue={row.page}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								if (renamePageTo(row.page!, e.currentTarget.value)) setMode('idle')
							}
							if (e.key === 'Escape') setMode('idle')
						}}
						onBlur={() => setMode('idle')}
					/>
				) : (
					<button className="outline-label" disabled={!real} onClick={() => real && setPage(row.page!, true)} title={row.page ?? 'Pages no node drills into'}>
						<span>{label}</span>
						{row.cycle && <Icon icon={CircleAlert} size={12} className="outline-cycle" />}
					</button>
				)}
				{row.hasChildren && !row.open && row.count > 0 && <span className="outline-count" title={`${row.count} pages inside`}>{row.count}</span>}
				{real && mode === 'idle' && (
					<span className="outline-actions">
						<button className="icon-btn" title="Add a child page" aria-label="Add a child page" onClick={() => setMode('child')}>
							<Icon icon={Plus} size={12} />
						</button>
						{row.page !== '' && (
							<>
								<button className="icon-btn" title="Rename page" aria-label="Rename page" onClick={() => setMode('rename')}>
									<Icon icon={Pencil} size={12} />
								</button>
								<button className="icon-btn" title="Delete page" aria-label="Delete page" onClick={() => setMode('delete')}>
									<Icon icon={Trash2} size={12} />
								</button>
							</>
						)}
					</span>
				)}
			</div>
			{mode === 'delete' && row.page && (
				<div className="outline-confirm" style={{ marginLeft: 22 + row.depth * 14 }}>
					<span>
						Delete <b>{row.label}</b>
						{row.count ? ` (its ${row.count} child page${row.count > 1 ? 's stay, unlinked' : ' stays, unlinked'})` : ''}? Links to it are removed.
					</span>
					<button
						className="btn danger small"
						onClick={() => {
							deletePageNamed(row.page!)
							setMode('idle')
						}}
					>
						Delete
					</button>
					<button className="btn small" onClick={() => setMode('idle')}>
						Cancel
					</button>
				</div>
			)}
			{mode === 'child' && row.page !== null && <ChildPagePicker parent={row.page} indent={22 + row.depth * 14} onDone={() => setMode('idle')} />}
		</div>
	)
}

/** "+ child page": link it from a new node on the parent page, or from one of its nodes. */
function ChildPagePicker({ parent, indent, onDone }: { parent: string; indent: number; onDone: () => void }) {
	const code = useStore((s) => s.code)
	const drill = useStore((s) => s.drill)
	const ref = useRef<HTMLDivElement>(null)
	const nodes = (parsedPage(code, parent)?.ir.nodes ?? []).filter((n) => !n.ext?.drill && !(parent === useStore.getState().page && drill[n.key]))
	useEffect(() => {
		const close = (e: PointerEvent) => {
			if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onDone()
		}
		window.addEventListener('pointerdown', close, true)
		return () => window.removeEventListener('pointerdown', close, true)
	}, [onDone])
	const pick = (key: string | null) => {
		onDone()
		addChildPage(parent, key)
	}
	return (
		<div className="outline-picker" ref={ref} style={{ marginLeft: indent }}>
			<div className="muted small">Link the new page from…</div>
			<button className="menu-item" onClick={() => pick(null)}>
				<Icon icon={Plus} size={13} />
				<span className="menu-label">a new node</span>
			</button>
			<div className="outline-picker-list">
				{nodes.slice(0, 60).map((n) => (
					<button key={n.key} className="menu-item" onClick={() => pick(n.key)}>
						<span className="menu-label">{n.label ?? n.key}</span>
						{n.isContainer && <span className="muted small">group</span>}
					</button>
				))}
			</div>
		</div>
	)
}
