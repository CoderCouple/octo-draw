/** Prompts and strict JSON schemas (structured outputs) for the two-pass vision pipeline. */

export const VISION_SHAPES = [
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
] as const

export const VISION_COLORS = ['blue', 'red', 'green', 'orange', 'purple', 'yellow', 'pink', 'teal', 'gray'] as const

export const VISION_KINDS = ['flowchart', 'architecture', 'sequence', 'erd', 'mindmap', 'tree', 'state', 'other'] as const

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })

const BBOX = {
	type: 'object',
	additionalProperties: false,
	required: ['x', 'y', 'w', 'h'],
	properties: {
		x: { type: 'integer', description: 'Left edge, 0-1000 of image width' },
		y: { type: 'integer', description: 'Top edge, 0-1000 of image height' },
		w: { type: 'integer', description: 'Width, 0-1000 of image width' },
		h: { type: 'integer', description: 'Height, 0-1000 of image height' },
	},
}

const POINT = {
	type: 'object',
	additionalProperties: false,
	required: ['x', 'y'],
	properties: { x: { type: 'integer' }, y: { type: 'integer' } },
}

/** Pass 1: the diagram's nodes and groups with normalised bounding boxes. */
export const VISION_NODES_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['is_diagram', 'kind', 'direction', 'title', 'nodes'],
	properties: {
		is_diagram: { type: 'boolean' },
		kind: { type: 'string', enum: [...VISION_KINDS] },
		direction: { type: 'string', enum: ['right', 'down', 'left', 'up'] },
		title: nullable({ type: 'string' }),
		nodes: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['id', 'label', 'shape', 'bbox', 'parent', 'is_container', 'color', 'icon', 'confidence'],
				properties: {
					id: { type: 'string', description: 'Short unique id like n1, n2' },
					label: { type: 'string', description: 'Visible text, exactly as written' },
					shape: { type: 'string', enum: [...VISION_SHAPES] },
					bbox: BBOX,
					parent: nullable({ type: 'string', description: 'id of the enclosing group/container' }),
					is_container: { type: 'boolean' },
					color: nullable({ type: 'string', enum: [...VISION_COLORS] }),
					icon: nullable({ type: 'string' }),
					confidence: { type: 'number', description: '0-1, how legible / certain' },
				},
			},
		},
	},
} as const

/** Pass 2: connections between the pass-1 nodes. */
export const VISION_EDGES_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['edges'],
	properties: {
		edges: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['from', 'to', 'direction', 'label', 'dashed', 'from_point', 'to_point', 'confidence'],
				properties: {
					from: { type: 'string', description: 'Node id at the tail' },
					to: { type: 'string', description: 'Node id at the head (arrowhead end)' },
					direction: { type: 'string', enum: ['forward', 'both', 'none'] },
					label: nullable({ type: 'string' }),
					dashed: { type: 'boolean' },
					from_point: nullable(POINT),
					to_point: nullable(POINT),
					confidence: { type: 'number' },
				},
			},
		},
	},
} as const

export const VISION_NODES_SYSTEM = `You extract the structure of diagram images (AI-generated images from ChatGPT or Gemini, screenshots of diagram tools, slides, whiteboard photos) as JSON.

This is pass 1 of 2: list the NODES only. Connections are extracted in a second pass.

Rules:
- Every box, circle, cylinder, diamond, cloud, actor, or icon with a caption is a node. Enclosing regions (VPCs, subnets, swimlanes, clusters, frames, dashed boundaries) are nodes with is_container true; their members set parent to the container's id.
- id: short unique ids (n1, n2, ...). label: the visible text EXACTLY as written (join multi-line text with a space). Do not translate or fix spelling. Unlabelled containers get a short descriptive label.
- shape: the closest shape (cylinder for databases/storage, diamond for decisions, oval for start/end terminals and circles, parallelogram for input/output, document for documents, cloud for clouds, otherwise rectangle).
- bbox: the node's bounding box in normalised integer coordinates, 0-1000 across the image width (x, w) and 0-1000 down the image height (y, h). Be as accurate as you can: positions are used to keep the layout.
- color: only when the fill or stroke clearly has one of the listed colours; otherwise null. icon: a lowercase icon name (e.g. database, server, user, cloud, lock) when a recognisable icon is drawn; otherwise null.
- confidence: 0-1, lower for hard-to-read text.
- kind: the diagram type. Use sequence for participants with lifelines and messages, erd for database tables with columns. direction: the dominant flow.
- If the image is not a diagram (a photo, illustration, chart), set is_diagram false and return no nodes.`

export const VISION_NODES_USER = 'List every node and group in this diagram image as JSON.'

export interface PromptNode {
	id: string
	label: string
	bbox: { x: number; y: number; w: number; h: number }
	is_container: boolean
}

export const VISION_EDGES_SYSTEM = `You extract the connections of diagram images as JSON.

This is pass 2 of 2. The nodes were already extracted; you get their ids, labels and bounding boxes (normalised 0-1000 of the image width/height). List every EDGE (line or arrow) between them.

Rules:
- from / to must be ids from the node list. The arrowhead end is "to". If a line has arrowheads on both ends use direction both; with no arrowheads use none (then from/to follow reading order).
- A line that ends on a container's border connects to the container's id.
- A line that splits (fan-out or fan-in through a junction) is one edge per pair of connected nodes.
- label: text written on or next to the line, exactly as written; otherwise null. dashed: true for dashed or dotted lines.
- from_point / to_point: where the line touches the tail / head node, in the same 0-1000 coordinates (null if unsure).
- Do not invent connections. confidence: 0-1.`

export function visionEdgesUser(nodes: PromptNode[]): string {
	const list = nodes
		.map((n) => `- ${n.id}: ${JSON.stringify(n.label)} bbox=[${n.bbox.x},${n.bbox.y},${n.bbox.w},${n.bbox.h}]${n.is_container ? ' (container)' : ''}`)
		.join('\n')
	return `Nodes in this diagram:\n${list}\n\nList every edge between these nodes as JSON.`
}

export function visionEdgesRepair(problems: string[], ids: string[]): string {
	return `Some edges could not be matched to the node list:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nValid node ids: ${ids.join(', ')}.\nReturn the FULL corrected edge list as JSON, using only valid ids.`
}
