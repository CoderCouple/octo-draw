/**
 * On-demand expansion (lazy drill): a node with a `src` ref (the scanned
 * origin, relative to the document's `source` directive) is turned into a new
 * page body by the expander registered for its kind.
 *
 * Expanders return ONE page body (octo DSL, no `page` lines, no `title`).
 * Child nodes carry their own full `src` so they are expandable again;
 * `children` names the node keys that are structurally inside the expanded
 * node (recursed into for `depth > 1`); other nodes with `src` are references
 * (ghosts, neighbours) and are not pre-expanded.
 */

import type { ConnectorContext, ConnectorFinding, SourceKind, SourceRef } from '../connectors/types'

/** A parsed `src` value: `<scheme>:<path>[#fragment]`. */
export interface SrcRef {
	/** Connector kind the scheme maps to (`hf` → `huggingface`); unknown schemes keep their name. */
	kind: SourceKind | (string & {})
	/** The scheme as written (`local`, `github`, `aws`, `gcp`, `azure`, `hf`). */
	scheme: string
	/**
	 * Kind-specific id. Code: a repo-relative POSIX path (`''` = the repo root).
	 * Cloud: the provider resource id (ARN, full resource name, ARM id).
	 * Hugging Face: `org/model`.
	 * The long GitHub form `github:o/r@sha:path` is reduced to `path` (with `repo`/`ref` filled in).
	 */
	path: string
	/** After `#`: code symbol path (`Parser`, `Parser.parseItem`, `uses:Postgres`), HF module path (`layers.0`). */
	fragment?: string
	/** GitHub long form only. */
	repo?: string
	ref?: string
	/** The original string. */
	raw: string
}

export interface ExpandNodeInput {
	/** The document's `source` directive (connector input), e.g. `/abs/repo`, `github.com/o/r@abc123`, `aws:./export.json`. */
	source: string
	/** The node's `src` prop. */
	src: string
	node: { key: string; label?: string }
	/** The page the node is on (`''` = root). */
	parentPage: string
	/** 1 (default) = one page; N = N levels (extra `page` sections in `body`). */
	depth?: number
	/** Page names already in the document: generated names avoid them (case-insensitive). */
	existingPages?: string[]
	/** Kind-specific options (cloud: `export` JSON, ...). */
	options?: Record<string, unknown>
	/** Caps (defaults: 30 nodes per page, 200 pages, 20 s). */
	maxNodesPerPage?: number
	maxPages?: number
	timeBudgetMs?: number
}

export interface ExpandNodeResult {
	/** Page body for `title`, followed by `page <name>` sections when `depth > 1`. */
	body: string
	/** The page name to add: `<parentPage> / <label>` (just `<label>` under the root), made unique. */
	title: string
	findings: ConnectorFinding[]
	warnings: string[]
	/** Names of every page in `body` (title first). */
	pages: string[]
}

/** What one expander call returns: a single page. */
export interface ExpandedPage {
	/** Octo page body: no `page` lines, no `title`. */
	body: string
	/** Keys of nodes structurally inside the expanded node (recursed into for depth > 1). Default: none. */
	children?: string[]
	findings?: ConnectorFinding[]
	warnings?: string[]
}

export interface ExpanderRequest {
	/** The parsed `source` directive (null when the document has none or it is not recognised). */
	source: SourceRef | null
	/** The raw `source` directive text. */
	sourceInput: string
	src: SrcRef
	node: { key: string; label?: string }
	options: Record<string, unknown>
	/** Node cap for this page (default 30). */
	maxNodes: number
}

export interface ExpandContext extends ConnectorContext {
	/**
	 * Per-run cache shared by every expander call of one `expandNode` (inventories,
	 * file lists, fetched files). Keys should be namespaced by kind (`aws:...`).
	 */
	cache?: Map<string, unknown>
}

export type Expander = (req: ExpanderRequest, ctx: ExpandContext) => Promise<ExpandedPage | null>
