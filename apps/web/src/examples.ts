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

const ARCHITECTURE = `// Architecture: catalog icons for cloud services and tools.
// Icons are monochrome; \`color: brand\` draws a logo in its brand color.
title Event-driven checkout
direction right
colorMode pastel
styleMode shadow
typeface clean

Web app [icon: react, color: brand]
Mobile [icon: smartphone]

AWS [icon: aws, color: orange] {
  CDN [icon: aws-cloudfront]
  API gateway [icon: aws-api-gateway]
  Auth [icon: aws-cognito]
  Orders [icon: aws-lambda]
  Payments [icon: aws-lambda]
  Receipts [icon: aws-s3]
}

Data [color: blue] {
  DB [icon: postgres, label: "Postgres 16", color: brand]
  Cache [icon: redis, color: brand]
}

Events [icon: kafka, label: "Kafka"]
Stripe [icon: stripe, color: brand]
Warehouse [icon: snowflake]
Dashboards [icon: grafana]

Web app, Mobile > CDN: HTTPS
CDN > API gateway
API gateway -- Auth
API gateway > Orders, Payments
Orders > DB
Orders <> Cache
Payments > Stripe: charge
Payments --> Receipts: PDF
Orders --> Events: order.placed
Payments --> Events: payment.settled
Events > Warehouse > Dashboards
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

/** Starter diagrams, one per kind: the top bar's Examples menu and `?example=<id>`. */
export const EXAMPLES: Example[] = [
	{ id: 'flowchart', label: 'Flowchart', code: FLOWCHART },
	{ id: 'architecture', label: 'Cloud architecture', code: ARCHITECTURE },
	{ id: 'sequence', label: 'Sequence diagram', code: SEQUENCE },
	{ id: 'erd', label: 'Entity relationship', code: ERD },
]

export function getExample(id: string): Example | undefined {
	return EXAMPLES.find((e) => e.id === id)
}
