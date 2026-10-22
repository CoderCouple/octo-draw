import { STARTER } from './starter'

export interface Example {
	id: string
	label: string
	code: string
}

const FLOWCHART = `// Flowchart: shapes, decisions and labeled branches
title Issue triage
direction down

New issue [shape: oval, icon: inbox]
Reproducible? [shape: diamond]
Needs info [icon: message-circle, color: orange]
Bug [icon: bug, color: red]
Prioritize [icon: list-ordered]
Done [shape: oval, icon: check]

New issue > Reproducible?
Reproducible? > Bug: yes
Reproducible? > Needs info: no
Needs info --> New issue: reporter replies
Bug > Prioritize > Done
`

const SEQUENCE = `// Sequence diagram: messages in time order, blocks, notes, activations
sequence
title Checkout
autoNumber on

Shopper [icon: user]
Web App [icon: monitor, color: blue]
API [icon: server]
Payments [icon: credit-card, color: green]
DB [icon: database]

Shopper > Web App: Place order
Web App > API: POST /orders
activate API
API > DB: insert order
DB --> API: order id
alt [label: card ok] {
	API > Payments: charge
	Payments --> API: approved
	API > DB: mark paid
} else [label: declined] {
	API --> Web App: 402 payment required
	note over Web App, API: user can retry with another card
}
loop [label: until shipped] {
	Web App > API: GET /orders/:id
}
API --> Web App: 201 created
deactivate API
Web App --> Shopper: Confirmation
`

const ERD = `// Entity-relationship diagram: entities with typed attributes and cardinality
erd
title Blog schema
notation crows-feet

users [icon: user, color: blue] {
	id string pk
	email string unique
	displayName string
	teamId string fk
}
teams [icon: users] {
	id string pk
	name string
}
posts [icon: file-text] {
	id string pk
	authorId string fk
	title string
	publishedAt timestamp
}
tags [icon: tag] {
	id string pk
	name string
}

users.teamId > teams.id: member of
users.id < posts.authorId: writes
posts <> tags
`

/** Starter diagrams, one per kind. Not wired to any UI here (the top bar is owned elsewhere). */
export const EXAMPLES: Example[] = [
	{ id: 'flowchart', label: 'Flowchart', code: FLOWCHART },
	{ id: 'architecture', label: 'Architecture', code: STARTER },
	{ id: 'sequence', label: 'Sequence diagram', code: SEQUENCE },
	{ id: 'erd', label: 'Entity relationship', code: ERD },
]

export function getExample(id: string): Example | undefined {
	return EXAMPLES.find((e) => e.id === id)
}
