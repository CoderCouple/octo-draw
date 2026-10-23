/**
 * Source connectors: anything that can be turned into an architecture diagram
 * (a local folder, a GitHub repo, a Hugging Face repo, a cloud account).
 * `parse` accepts a URL or shorthand (`github.com/o/r`, `o/r@ref`, `hf:org/model`,
 * `aws:us-east-1`) so one input box can take anything; `scan` produces octo code.
 */

export type SourceKind = 'local' | 'github' | 'huggingface' | 'aws' | 'gcp' | 'azure'

export interface SourceRef {
	kind: SourceKind
	/** Kind-specific id: a path, `owner/repo`, `org/model`, an account/region... */
	id: string
	/** Branch, tag, commit, revision. */
	ref?: string
	options?: Record<string, unknown>
}

export interface ConnectorContext {
	fetch: typeof fetch
	/** Credentials are read from here (server-side only; never returned in results). */
	env: Record<string, string | undefined>
	signal?: AbortSignal
	log?: (msg: string) => void
}

export interface ConnectorFinding {
	analyzer: string
	confidence: number
	notes?: string[]
}

export interface ConnectorResult {
	code: string
	findings: ConnectorFinding[]
	warnings: string[]
	source: SourceRef
	/** The files that were scanned (optional; for follow-ups like AI explain). Never serialized to clients. */
	files?: Map<string, string>
}

export interface Connector {
	kind: SourceKind
	/** Returns null when the input is not for this connector. */
	parse(input: string): SourceRef | null
	scan(ref: SourceRef, ctx: ConnectorContext): Promise<ConnectorResult>
}

/** Thrown for user-facing connector failures (bad input, not found, rate limited). `status` is an HTTP-ish code. */
export class ConnectorError extends Error {
	constructor(
		message: string,
		public status = 400,
	) {
		super(message)
	}
}
