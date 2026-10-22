export const STARTER = `// Welcome to octo-draw: write diagram code, see it drawn live.
// Drag nodes to pin them, double-click to rename, paste mermaid or ASCII to import.
title Checkout system
direction right
colorMode pastel
styleMode shadow
typeface clean

Shopper [icon: users, shape: oval, color: purple]

Edge [color: blue] {
  CDN [icon: globe]
  API gateway [icon: router]
}

Services [color: green] {
  Orders [icon: shopping-cart]
  Payments [icon: credit-card]
  Fraud check [shape: diamond, color: orange]
  Worker [icon: cpu]
}

DB [shape: cylinder, icon: database, label: "Postgres 16", color: blue]
Events [shape: cylinder, icon: radio, label: "Kafka", color: gray]

Shopper > CDN: HTTPS
CDN > API gateway
API gateway > Orders, Payments
Payments > Fraud check: score
Fraud check > Worker: approved
Orders > DB
Worker --> Events: async
Orders <> Payments
Worker -- DB
`
