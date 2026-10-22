/**
 * Agent action API — the JSON contract AI agents (in-app AI bar, MCP clients,
 * scripts) use to read and edit a diagram. Actions address nodes/edges by
 * semantic key, never by canvas coordinates, so they compose with auto-layout.
 *
 * Actions are applied to the octo DSL source (via minimal text patches where
 * possible), so the code panel always reflects what the agent did and one
 * agent run is one undo step.
 */

import type { Direction, NodeShape } from './ir'

export type AgentAction =
	| {
			type: 'addNode'
			key: string
			label?: string
			shape?: NodeShape
			icon?: string
			color?: string
			/** Container key to place the node in. */
			parent?: string
	  }
	| {
			type: 'updateNode'
			key: string
			label?: string
			shape?: NodeShape
			icon?: string
			color?: string
	  }
	| { type: 'removeNode'; key: string }
	| {
			type: 'addEdge'
			from: string
			to: string
			label?: string
			/** Eraser operator: `>` arrow, `<>` both ways, `-` line, `--` dotted line, `-->` dotted arrow. */
			op?: '>' | '<' | '<>' | '-' | '--' | '-->'
			id?: string
	  }
	| { type: 'removeEdge'; from: string; to: string; id?: string }
	| { type: 'addGroup'; key: string; label?: string; color?: string; icon?: string; children?: string[] }
	| { type: 'setDirection'; direction: Direction }
	/** Replace the whole diagram. `format` defaults to octo. */
	| { type: 'replaceCode'; code: string; format?: 'octo' | 'mermaid' }

export interface ApplyResult {
	code: string
	applied: number
	errors: { index: number; message: string }[]
}
