/**
 * Shared scan types. Analyzers are pure: they read `ScanFiles` (repo-relative
 * POSIX paths → text) and return an `AnalyzerResult`; nothing here touches the
 * file system, so the same code runs in the browser on a picked folder.
 */

import type { NodeShape } from '@octo-draw/core'

/** Repo-relative POSIX path (`apps/server/src/app.ts`) → file text. */
export type ScanFiles = Map<string, string>

/** `actions` (GitHub Actions) runs via `ScanOptions.ci`, not `only`. */
export type AnalyzerName = 'compose' | 'k8s' | 'terraform' | 'code' | 'openapi' | 'actions'
export const ANALYZERS: readonly AnalyzerName[] = ['code', 'compose', 'k8s', 'terraform', 'openapi']

export interface ScanOptions {
	/** Run only these analyzers (default: all). */
	only?: AnalyzerName[]
	/** Diagram title (default: root package name or "Architecture"). */
	title?: string
	/** Name of the scanned folder, used for the default title. */
	rootName?: string
	/** Add a "CI/CD" page from GitHub Actions workflows (default false; the GitHub connector turns it on). */
	ci?: boolean
	/** Max nodes on a module page before folding the rest (default 25). */
	maxModuleNodes?: number
}

export interface Finding {
	analyzer: AnalyzerName
	/** 0..1: how sure the analyzer is that what it drew is the real architecture. */
	confidence: number
	notes: string[]
}

/** What kind of thing a node is; drives merging and styling. */
export type NodeRole = 'service' | 'library' | 'frontend' | 'store' | 'queue' | 'external' | 'client' | 'group' | 'infra' | 'config' | 'api'

export interface ArchNode {
	key: string
	label?: string
	icon?: string
	shape?: NodeShape
	color?: string
	parent?: string
	isContainer?: boolean
	role: NodeRole
	/** Target page name for drill-down. */
	drill?: string
	/** URL (e.g. the GitHub path of a workspace). */
	link?: string
	/** Technology (`postgres`, `redis`, ...) for cross-analyzer merging of data stores. */
	tech?: string
	/** Names this node is known by (workspace names, dirs, compose names) for merging. */
	aliases?: string[]
	/** Repo-relative directory the node lives in (workspace dir, compose build context). */
	dir?: string
	/** Free-form facts (ports, image, entrypoints) kept for summaries and AI explain. */
	facts?: string[]
}

export interface ArchEdge {
	from: string
	to: string
	label?: string
	/** Dotted line (weak / config / inferred). */
	dotted?: boolean
	/** No arrowheads. */
	plain?: boolean
}

export interface ArchGraph {
	nodes: ArchNode[]
	edges: ArchEdge[]
}

export interface ArchPage extends ArchGraph {
	name: string
	/** Which analyzer made it (for ordering and findings). */
	analyzer: AnalyzerName
}

export interface AnalyzerResult {
	analyzer: AnalyzerName
	confidence: number
	notes: string[]
	warnings: string[]
	/** Contribution to the root page. */
	root: ArchGraph
	pages: ArchPage[]
	/** Analyzer-specific details other analyzers may use (e.g. code workspaces for OpenAPI linking). */
	meta?: Record<string, unknown>
}

export function emptyResult(analyzer: AnalyzerName): AnalyzerResult {
	return { analyzer, confidence: 0, notes: [], warnings: [], root: { nodes: [], edges: [] }, pages: [] }
}
