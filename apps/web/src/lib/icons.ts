import { create } from 'zustand'

export type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][]

/** Friendly names AI models and Eraser users tend to write, mapped to lucide names. */
const ALIASES: Record<string, string> = {
	db: 'database',
	postgres: 'database',
	postgresql: 'database',
	mysql: 'database',
	mongodb: 'database',
	sql: 'database',
	redis: 'database-zap',
	cache: 'zap',
	queue: 'list-ordered',
	kafka: 'radio',
	pubsub: 'radio',
	sqs: 'list-ordered',
	user: 'user',
	person: 'user',
	customer: 'user',
	api: 'webhook',
	gateway: 'router',
	'api-gateway': 'router',
	'load-balancer': 'split',
	lb: 'split',
	lambda: 'square-function',
	function: 'square-function',
	serverless: 'square-function',
	storage: 'hard-drive',
	s3: 'archive',
	bucket: 'archive',
	cdn: 'globe',
	browser: 'globe',
	web: 'globe',
	internet: 'globe',
	mobile: 'smartphone',
	phone: 'smartphone',
	ios: 'smartphone',
	android: 'smartphone',
	email: 'mail',
	auth: 'key-round',
	security: 'shield',
	monitor: 'activity',
	monitoring: 'activity',
	metrics: 'chart-column',
	chart: 'chart-column',
	analytics: 'chart-column',
	logs: 'scroll-text',
	logging: 'scroll-text',
	docker: 'container',
	kubernetes: 'ship-wheel',
	k8s: 'ship-wheel',
	ai: 'sparkles',
	llm: 'brain',
	ml: 'brain',
	model: 'brain',
	agent: 'bot',
	payment: 'credit-card',
	payments: 'credit-card',
	stripe: 'credit-card',
	app: 'app-window',
	frontend: 'monitor',
	backend: 'server',
	service: 'box',
	microservice: 'box',
	worker: 'cpu',
	compute: 'cpu',
	vm: 'server',
	ec2: 'server',
	network: 'network',
	vpc: 'network',
	dns: 'globe',
	git: 'git-branch',
	ci: 'workflow',
	cd: 'workflow',
	notification: 'bell',
	notifications: 'bell',
	settings: 'settings',
	config: 'settings',
	home: 'house',
	cart: 'shopping-cart',
	shop: 'shopping-cart',
	building: 'building-2',
	company: 'building-2',
	chat: 'message-square',
	message: 'message-square',
	search: 'search',
	elasticsearch: 'search',
	file: 'file',
	document: 'file-text',
	docs: 'file-text',
	cloud: 'cloud',
	clock: 'clock',
	cron: 'clock',
	scheduler: 'calendar-clock',
	webhook: 'webhook',
	event: 'zap',
	events: 'zap',
	stream: 'waves',
}

const toPascal = (kebab: string) =>
	kebab
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((p) => p[0].toUpperCase() + p.slice(1))
		.join('')

const toKebab = (pascal: string) =>
	pascal
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/([A-Za-z])([0-9])/g, '$1-$2')
		.toLowerCase()

let iconTable: Record<string, IconNode> | null = null
let kebabNames: string[] = []

interface IconState {
	loaded: boolean
}
export const useIcons = create<IconState>(() => ({ loaded: false }))

let loading: Promise<void> | null = null
/** Loads the lucide icon set lazily (its own chunk). */
export function loadIcons(): Promise<void> {
	if (!loading) {
		loading = import('lucide/dist/esm/iconsAndAliases.mjs')
			.then((m) => {
				iconTable = m as unknown as Record<string, IconNode>
				const names = new Set<string>()
				for (const k of Object.keys(iconTable)) if (!k.endsWith('Icon') && !k.startsWith('Lucide')) names.add(toKebab(k))
				kebabNames = [...names].sort()
				useIcons.setState({ loaded: true })
			})
			.catch((err) => {
				// allow a retry on the next call instead of silently showing badges forever
				console.warn('icon set failed to load', err)
				loading = null
			})
	}
	return loading
}

export function iconNames(): string[] {
	return kebabNames.length ? kebabNames : Object.keys(ALIASES)
}

export function aliasNames(): string[] {
	return Object.keys(ALIASES)
}

/** lucide icon node for a kebab name / alias, or null when unknown (render a badge). */
export function getIcon(name: string | undefined): IconNode | null {
	if (!name || !iconTable) return null
	const n = name.trim().toLowerCase()
	const candidates = [n, ALIASES[n], n.replace(/^(aws|gcp|azure)-/, ''), ALIASES[n.replace(/^(aws|gcp|azure)-/, '')]]
	for (const c of candidates) {
		if (!c) continue
		const hit = iconTable[toPascal(c)]
		if (hit) return hit
	}
	return null
}
