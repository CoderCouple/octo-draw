/**
 * DiagramIR — the hub every octo-draw pipeline converts into and out of.
 *
 *   octo DSL ─┐                        ┌─> octo DSL
 *   mermaid ──┼─> DiagramIR ─> layout ─┼─> canvas
 *   ASCII ────┤                        ├─> mermaid
 *   agent JSON┘                        └─> agent JSON
 *
 * Identity rule: `key` is semantic identity (DSL name / mermaid id), never the
 * display label. Canvas edits change `label`, not `key`.
 */

export type DiagramKind = 'flowchart' | 'architecture' | 'sequence' | 'erd'

export type Direction = 'down' | 'up' | 'right' | 'left'

export type NodeShape =
	| 'rectangle'
	| 'oval'
	| 'ellipse'
	| 'diamond'
	| 'cylinder'
	| 'hexagon'
	| 'parallelogram'
	| 'document'
	| 'trapezoid'
	| 'triangle'
	| 'star'
	| 'cloud'

export const NODE_SHAPES: readonly NodeShape[] = [
	'rectangle',
	'oval',
	'ellipse',
	'diamond',
	'cylinder',
	'hexagon',
	'parallelogram',
	'document',
	'trapezoid',
	'triangle',
	'star',
	'cloud',
]

export type ColorMode = 'pastel' | 'bold' | 'outline'
export type StyleMode = 'shadow' | 'plain' | 'watercolor'
export type Typeface = 'rough' | 'clean' | 'mono'

/** Source range in the original text, 0-based offsets. Used for minimal text patching. */
export interface SourceSpan {
	from: number
	to: number
	/** 1-based line of `from`. */
	line: number
}

export interface IRStyle {
	/** Palette name (`blue`, `red`, ...) or exact `#hex`. */
	color?: string
	dash?: 'solid' | 'dotted' | 'dashed'
}

export interface IRNode {
	key: string
	label?: string
	shape?: NodeShape
	icon?: string
	parent?: string
	isContainer?: boolean
	style?: IRStyle
	link?: string
	/** Optional authored geometry. Absent means "let layout decide". */
	geometry?: { x?: number; y?: number; w?: number; h?: number; pinned?: boolean }
	/** Span of the declaration that defined this node (first one wins). */
	span?: SourceSpan
	/** Unknown properties survive round-trips here. */
	ext?: Record<string, string>
	/** ERD only: entity attributes, in declaration order. */
	fields?: IRField[]
}

/** ERD attribute: `id string pk`. `meta` holds lowercase flags like `pk`, `fk`, `unique`. */
export interface IRField {
	name: string
	type?: string
	meta?: string[]
}

/** ERD relationship cardinality, read from the `from` side: `1-n` = one `from` to many `to`. */
export type Cardinality = '1-1' | '1-n' | 'n-1' | 'n-n'

export type ArrowHead = 'none' | 'arrow'

export interface IREdge {
	/** Explicit `id:` or derived `${from}->${to}#${ordinal}`. */
	key: string
	from: string
	to: string
	label?: string
	arrow: { start: ArrowHead; end: ArrowHead }
	line: { dash: 'solid' | 'dotted' }
	style?: IRStyle
	span?: SourceSpan
	/** ERD only: attribute on the `from` / `to` entity the relationship attaches to. */
	fromField?: string
	toField?: string
	/** ERD only. */
	cardinality?: Cardinality
}

// ---------------------------------------------------------------------------
// Sequence diagrams: participants are IR nodes (in column order); time-ordered
// events live in `DiagramIR.sequence`.

export interface SeqMessage {
	kind: 'message'
	from: string
	to: string
	label?: string
	arrow: { start: ArrowHead; end: ArrowHead }
	dash: 'solid' | 'dotted'
	color?: string
	span?: SourceSpan
}

export interface SeqActivation {
	kind: 'activate' | 'deactivate'
	target: string
	span?: SourceSpan
}

export interface SeqNote {
	kind: 'note'
	placement: 'over' | 'left' | 'right'
	targets: string[]
	text: string
	color?: string
	span?: SourceSpan
}

export type SeqBlockType = 'loop' | 'alt' | 'opt' | 'par' | 'break' | 'critical'

export interface SeqSection {
	label?: string
	events: SeqEvent[]
}

export interface SeqBlock {
	kind: 'block'
	type: SeqBlockType
	color?: string
	icon?: string
	/** First section holds the block's own label; later ones are `else` / `and` branches. */
	sections: SeqSection[]
	span?: SourceSpan
}

export type SeqEvent = SeqMessage | SeqActivation | SeqNote | SeqBlock

export interface IRSequence {
	events: SeqEvent[]
	autoNumber?: boolean
}

export interface DiagramIR {
	version: 1
	kind: DiagramKind
	direction: Direction
	style: { colorMode?: ColorMode; styleMode?: StyleMode; typeface?: Typeface }
	title?: string
	/**
	 * Root page only: the document-level `source <connector input>` directive
	 * (`github.com/o/r@abc123`, `/abs/repo`, `aws:./export.json`). Node `src`
	 * refs (in `ext.src`) are relative to it.
	 */
	source?: string
	nodes: IRNode[]
	edges: IREdge[]
	/** kind 'sequence' only. */
	sequence?: IRSequence
	/** kind 'erd' only. */
	erd?: { notation?: 'crows-feet' | 'chen' }
}

export interface Diagnostic {
	from: number
	to: number
	severity: 'error' | 'warning'
	message: string
}

export interface ParseResult {
	ir: DiagramIR
	diagnostics: Diagnostic[]
}

export function emptyIR(kind: DiagramKind = 'flowchart'): DiagramIR {
	return {
		version: 1,
		kind,
		direction: kind === 'architecture' || kind === 'erd' ? 'right' : 'down',
		style: {},
		nodes: [],
		edges: [],
	}
}

// ---------------------------------------------------------------------------
// Layout output — what the canvas renders.

export interface Point {
	x: number
	y: number
}

export interface LaidOutNode {
	key: string
	x: number
	y: number
	w: number
	h: number
	isContainer: boolean
	depth: number
	/** ERD entities: attribute rows, `y` relative to the node's top. */
	fields?: { name: string; y: number; h: number }[]
}

export interface LaidOutEdge {
	key: string
	/** Polyline from source border to target border, absolute coordinates. */
	points: Point[]
	/** Where to draw the label, if any. */
	labelAt?: Point
}

export interface DiagramLayout {
	nodes: Record<string, LaidOutNode>
	edges: Record<string, LaidOutEdge>
	bounds: { x: number; y: number; w: number; h: number }
	/** kind 'sequence' only: everything besides participant boxes (which are in `nodes`). */
	sequence?: SequenceLayout
}

export interface SequenceLayout {
	/** Participant head boxes are `nodes[key]`; `footY` is the top of the mirrored foot box. */
	participants: { key: string; x: number; footY: number }[]
	lifelines: { key: string; x: number; y1: number; y2: number }[]
	messages: {
		/** Index in depth-first event order. */
		index: number
		from: string
		to: string
		x1: number
		x2: number
		y: number
		/** Self messages loop out to the right and come back at `y2`. */
		self: boolean
		y2?: number
		label?: string
		labelAt?: Point
		number?: number
		arrow: { start: ArrowHead; end: ArrowHead }
		dash: 'solid' | 'dotted'
		color?: string
	}[]
	activations: { key: string; x: number; y1: number; y2: number; depth: number }[]
	notes: { x: number; y: number; w: number; h: number; text: string; color?: string }[]
	blocks: {
		type: SeqBlockType
		x: number
		y: number
		w: number
		h: number
		color?: string
		/** One per section; `y` is the divider (first = frame top). */
		sections: { y: number; label?: string }[]
	}[]
}

export interface LayoutOptions {
	/** Positions the user dragged on the canvas, keyed by node key (top-left). */
	pinned?: Record<string, Point>
	/** Measures label text; defaults to a character-width estimate (works headless). */
	measureText?: (text: string, fontSize: number) => { w: number; h: number }
}
