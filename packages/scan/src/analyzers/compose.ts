/**
 * docker-compose analyzer: services, depends_on / links, connection URLs in
 * the environment, published ports (edges from an Internet node), named
 * volumes (cylinders) and user networks (groups, when they partition services).
 * Environment values are only searched for host names; they are never output.
 */

import { techForImage } from '../tech'
import { emptyResult, type AnalyzerResult, type ArchEdge, type ArchNode, type ScanFiles } from '../types'
import { asArr, asObj, asStr, basename, dirname, isObj, join, KeyAllocator, parseYaml, plural } from '../util'

const COMPOSE_FILE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/

export function composeFiles(files: ScanFiles): string[] {
	return [...files.keys()].filter((p) => COMPOSE_FILE.test(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}

interface Svc {
	name: string
	image?: string
	build?: string
	ports: string[]
	deps: string[]
	networks: string[]
	volumes: string[]
	envHosts: string[]
	file: string
}

function portList(v: unknown): string[] {
	const out: string[] = []
	for (const p of asArr(v)) {
		if (isObj(p)) {
			const pub = asStr(p.published)
			if (pub) out.push(pub)
			continue
		}
		const s = asStr(p)
		if (!s) continue
		// "8080:80", "127.0.0.1:5432:5432", "3000", "9000-9001:9000-9001/tcp"
		const parts = s.replace(/\/(tcp|udp)$/, '').split(':')
		if (parts.length === 1) continue // container-only port: not published to a fixed host port
		out.push(parts[parts.length - 2])
	}
	return out
}

function names(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => asStr(x)?.split(':')[0]).filter((x): x is string => !!x)
	if (isObj(v)) return Object.keys(v)
	return []
}

/** Host names referenced from env values like `postgres://u:p@db:5432/app` or `REDIS_HOST=cache`. */
function envHosts(env: unknown): string[] {
	const values: string[] = []
	if (Array.isArray(env)) for (const e of env) values.push(String(e).split('=').slice(1).join('='))
	else if (isObj(env)) for (const v of Object.values(env)) if (v !== null && v !== undefined) values.push(String(v))
	const hosts: string[] = []
	for (const v of values) {
		for (const m of v.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([A-Za-z0-9_.-]+)/g)) hosts.push(m[1])
		if (/^[a-z][a-z0-9_-]*(:\d+)?$/.test(v)) hosts.push(v.split(':')[0])
	}
	return hosts
}

export function analyzeCompose(files: ScanFiles): AnalyzerResult {
	const r = emptyResult('compose')
	const paths = composeFiles(files)
	if (!paths.length) return r
	const svcs = new Map<string, Svc>()
	const namedVolumes = new Set<string>()
	const userNetworks = new Set<string>()
	for (const path of paths) {
		const doc = asObj(parseYaml(files.get(path) ?? ''))
		const services = asObj(doc.services)
		if (!Object.keys(services).length) {
			if (!isObj(doc)) r.warnings.push(`${path}: not valid YAML`)
			continue
		}
		for (const v of Object.keys(asObj(doc.volumes))) namedVolumes.add(v)
		for (const n of Object.keys(asObj(doc.networks))) userNetworks.add(n)
		for (const [name, raw] of Object.entries(services)) {
			const s = asObj(raw)
			const build = typeof s.build === 'string' ? s.build : asStr(asObj(s.build).context)
			const prev = svcs.get(name)
			const svc: Svc = prev ?? { name, ports: [], deps: [], networks: [], volumes: [], envHosts: [], file: path }
			// override files (compose.override.yml) merge into the same service
			svc.image = asStr(s.image) ?? svc.image
			if (build !== undefined) svc.build = join(dirname(path), build)
			svc.ports.push(...portList(s.ports))
			svc.deps.push(...names(s.depends_on), ...names(s.links))
			svc.networks.push(...names(s.networks))
			for (const v of asArr(s.volumes)) {
				const src = isObj(v) ? asStr(v.source) : asStr(v)?.split(':')[0]
				if (src && !/^[.~/$]/.test(src)) svc.volumes.push(src)
			}
			svc.envHosts.push(...envHosts(s.environment))
			svcs.set(name, svc)
		}
	}
	if (!svcs.size) return r

	const keys = new KeyAllocator()
	const svcKey = new Map<string, string>()
	for (const name of svcs.keys()) svcKey.set(name, keys.take(name))
	const nodes: ArchNode[] = []
	const edges: ArchEdge[] = []
	const edgeSet = new Set<string>()
	const addEdge = (e: ArchEdge) => {
		const id = `${e.from}\u0000${e.to}`
		if (edgeSet.has(id) || e.from === e.to) return
		edgeSet.add(id)
		edges.push(e)
	}

	// groups: only when every service sits in exactly one of >= 2 user networks
	const nets = [...userNetworks].filter((n) => n !== 'default')
	const partition = nets.length >= 2 && [...svcs.values()].every((s) => s.networks.filter((n) => nets.includes(n)).length === 1)
	const netKey = new Map<string, string>()
	if (partition) {
		for (const n of nets) {
			if (![...svcs.values()].some((s) => s.networks.includes(n))) continue
			const k = keys.take(`${n} network`)
			netKey.set(n, k)
			nodes.push({ key: k, label: n, role: 'group', isContainer: true, icon: 'network' })
		}
		r.notes.push(`grouped services by ${plural(netKey.size, 'network')}`)
	} else if (nets.length) r.notes.push(`${plural(nets.length, 'network')} not drawn as groups (services span several)`)

	let published = 0
	const internet = 'Internet'
	for (const s of svcs.values()) {
		const key = svcKey.get(s.name)!
		const t = techForImage(s.image)
		const facts: string[] = []
		if (s.image) facts.push(`image ${s.image}`)
		if (s.build) facts.push(`build ${s.build || '.'}`)
		if (s.ports.length) facts.push(`ports ${s.ports.join(', ')}`)
		nodes.push({
			key,
			icon: t?.icon ?? (s.build !== undefined ? 'container' : 'docker'),
			shape: t?.shape,
			role: t?.role ?? 'service',
			tech: t?.tech,
			parent: partition ? netKey.get(s.networks.find((n) => nets.includes(n))!) : undefined,
			aliases: [s.name, ...(s.build !== undefined ? [s.build === '' ? '.' : s.build, basename(s.build)] : [])],
			dir: s.build,
			facts,
		})
		for (const d of s.deps) if (svcKey.has(d)) addEdge({ from: key, to: svcKey.get(d)! })
		for (const h of s.envHosts) if (svcKey.has(h) && h !== s.name) addEdge({ from: key, to: svcKey.get(h)! })
		if (s.ports.length) {
			published++
			addEdge({ from: internet, to: key, label: s.ports.map((p) => `:${p}`).join(', ') })
		}
	}
	if (published) nodes.unshift({ key: internet, icon: 'globe', shape: 'oval', role: 'client' })

	const volKey = new Map<string, string>()
	for (const s of svcs.values()) {
		for (const v of s.volumes) {
			if (!namedVolumes.has(v)) continue
			if (!volKey.has(v)) {
				const k = keys.take(`${v} volume`)
				volKey.set(v, k)
				nodes.push({ key: k, label: v, shape: 'cylinder', icon: 'storage', role: 'store' })
			}
			addEdge({ from: svcKey.get(s.name)!, to: volKey.get(v)!, plain: true })
		}
	}

	r.root = { nodes, edges }
	r.confidence = 0.9
	r.notes.unshift(`${plural(svcs.size, 'service')} from ${paths.join(', ')}`)
	if (volKey.size) r.notes.push(`${plural(volKey.size, 'named volume')}`)
	if (published) r.notes.push(`${plural(published, 'service')} publish ports`)
	return r
}
