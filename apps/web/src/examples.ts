import DEEP from '@octo-draw/core/fixtures/deep.octo?raw'

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

const DRILL = `// Drill-down: double-click a node with the corner mark to open its page.
// Each \`page\` line starts a sub-diagram; the chevron on a group collapses it.
title Checkout platform
direction right
colorMode pastel
styleMode shadow

Shopper [icon: user, shape: oval]
Web app [icon: monitor]
API gateway [icon: server]
Checkout [icon: shopping-cart, color: blue, drill: Checkout flow]
Payments [icon: credit-card, color: green]
Fulfillment [icon: truck, color: orange]

Data [icon: database, color: purple] {
  Orders DB [icon: database, shape: cylinder]
  Cache [icon: zap]
  Events [icon: radio]
}

Shopper > Web app > API gateway
API gateway > Checkout, Payments
Checkout > Payments: charge
Checkout > Fulfillment: ship
Checkout > Orders DB
Payments > Events: paid
Fulfillment > Events
API gateway > Cache

page Checkout flow
sequence
Shopper [icon: user]
Web app [icon: monitor]
Checkout [icon: shopping-cart]
Payments [icon: credit-card]
Shopper > Web app: Place order
Web app > Checkout: POST /checkout
activate Checkout
Checkout > Payments: authorize
Payments --> Checkout: approved
Checkout --> Web app: 201 created
deactivate Checkout
Web app --> Shopper: Order confirmed

page Payments
direction right
Authorize [icon: shield-check]
Fraud check [shape: diamond]
Capture [icon: credit-card]
Refund [icon: undo-2, color: red]
Authorize > Fraud check
Fraud check > Capture: ok
Fraud check > Refund: suspicious
Ledger [icon: book-open]
Capture --> Ledger

page Fulfillment
direction down
Warehouse [color: orange] {
  Pick [icon: hand]
  Pack [icon: package]
}
Carrier [icon: truck]
Delivered [shape: oval, icon: check]
Pick > Pack > Carrier > Delivered
`

/** Starter diagrams, one per kind: the top bar's Examples menu and `?example=<id>`. */
export const EXAMPLES: Example[] = [
	{ id: 'flowchart', label: 'Flowchart', code: FLOWCHART },
	{ id: 'architecture', label: 'Cloud architecture', code: ARCHITECTURE },
	{ id: 'sequence', label: 'Sequence diagram', code: SEQUENCE },
	{ id: 'erd', label: 'Entity relationship', code: ERD },
	{ id: 'drill', label: 'Drill-down', code: DRILL },
	{ id: 'deep', label: 'Deep system', code: DEEP },
]

export function getExample(id: string): Example | undefined {
	return EXAMPLES.find((e) => e.id === id)
}
