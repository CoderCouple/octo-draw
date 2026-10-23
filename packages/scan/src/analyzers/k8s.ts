/**
 * Kubernetes manifests (multi-document YAML): workloads grouped by namespace,
 * Service → workload by label selector, Ingress → Service, ConfigMap / Secret
 * references (Secrets by name only, never values), HPAs and PVCs.
 */

import { techForImage } from '../tech'
import { emptyResult, type AnalyzerResult, type ArchEdge, type ArchNode, type ScanFiles } from '../types'
import { asArr, asObj, asStr, isObj, KeyAllocator, parseYamlAll, plural, type Obj } from '../util'

const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'ReplicaSet', 'Pod'])

interface Res {
	kind: string
	name: string
	ns: string
	doc: Obj
	file: string
}

/** Does this text look like a Kubernetes manifest? (cheap pre-check before parsing) */
const looksK8s = (text: string) => /^apiVersion:/m.test(text) && /^kind:\s*\w+/m.test(text)

function podSpec(r: Res): { labels: Obj; spec: Obj } {
	const spec = asObj(r.doc.spec)
	if (r.kind === 'Pod') return { labels: asObj(asObj(r.doc.metadata).labels), spec }
	const tmpl = r.kind === 'CronJob' ? asObj(asObj(asObj(asObj(spec.jobTemplate).spec).template)) : asObj(spec.template)
	return { labels: asObj(asObj(tmpl.metadata).labels), spec: asObj(tmpl.spec) }
}

function refs(spec: Obj): { configMaps: string[]; secrets: string[]; pvcs: string[]; images: string[] } {
	const configMaps: string[] = []
	const secrets: string[] = []
	const pvcs: string[] = []
	const images: string[] = []
	const containers = [...asArr(spec.containers), ...asArr(spec.initContainers)].map(asObj)
	for (const c of containers) {
		const img = asStr(c.image)
		if (img) images.push(img)
		for (const ef of asArr(c.envFrom).map(asObj)) {
			const cm = asStr(asObj(ef.configMapRef).name)
			const sec = asStr(asObj(ef.secretRef).name)
			if (cm) configMaps.push(cm)
			if (sec) secrets.push(sec)
		}
		for (const e of asArr(c.env).map(asObj)) {
			const vf = asObj(e.valueFrom)
			const cm = asStr(asObj(vf.configMapKeyRef).name)
			const sec = asStr(asObj(vf.secretKeyRef).name)
			if (cm) configMaps.push(cm)
			if (sec) secrets.push(sec)
		}
	}
	for (const v of asArr(spec.volumes).map(asObj)) {
		const cm = asStr(asObj(v.configMap).name)
		const sec = asStr(asObj(v.secret).secretName)
		const pvc = asStr(asObj(v.persistentVolumeClaim).claimName)
		if (cm) configMaps.push(cm)
		if (sec) secrets.push(sec)
		if (pvc) pvcs.push(pvc)
		for (const src of asArr(asObj(v.projected).sources).map(asObj)) {
			const pcm = asStr(asObj(src.configMap).name)
			const psec = asStr(asObj(src.secret).name)
			if (pcm) configMaps.push(pcm)
			if (psec) secrets.push(psec)
		}
	}
	for (const s of asArr(spec.imagePullSecrets).map(asObj)) {
		const n = asStr(s.name)
		if (n) secrets.push(n)
	}
	return { configMaps, secrets, pvcs, images }
}

const selects = (selector: Obj, labels: Obj) => {
	const entries = Object.entries(selector)
	return entries.length > 0 && entries.every(([k, v]) => String(labels[k]) === String(v))
}

export function analyzeK8s(files: ScanFiles): AnalyzerResult {
	const r = emptyResult('k8s')
	const resources: Res[] = []
	let badDocs = 0
	for (const [path, text] of files) {
		if (!/\.ya?ml$/.test(path) || !looksK8s(text)) continue
		if (/\{\{/.test(text)) {
			r.warnings.push(`${path}: templated YAML (Helm?) skipped`)
			continue
		}
		const { docs, errors } = parseYamlAll(text)
		badDocs += errors
		const flat = docs.flatMap((d) => (isObj(d) && d.kind === 'List' ? asArr(d.items) : [d]))
		for (const d of flat) {
			if (!isObj(d) || typeof d.kind !== 'string' || typeof d.apiVersion !== 'string') continue
			const md = asObj(d.metadata)
			const name = asStr(md.name)
			if (!name) continue
			resources.push({ kind: d.kind, name, ns: asStr(md.namespace) ?? 'default', doc: d, file: path })
		}
	}
	if (badDocs) r.warnings.push(`${plural(badDocs, 'YAML document')} could not be parsed`)
	const workloads = resources.filter((x) => WORKLOADS.has(x.kind))
	const ingresses = resources.filter((x) => x.kind === 'Ingress')
	const services = resources.filter((x) => x.kind === 'Service')
	if (!workloads.length && !services.length && !ingresses.length) return r

	const keys = new KeyAllocator(['Internet'])
	const nodes: ArchNode[] = []
	const edges: ArchEdge[] = []
	const namespaces = [...new Set([...workloads, ...services, ...ingresses].map((x) => x.ns))].sort()
	const groupNs = namespaces.length > 1 || namespaces[0] !== 'default'
	const nsKey = new Map<string, string>()
	if (groupNs) for (const ns of namespaces) {
		const k = keys.take(`ns ${ns}`)
		nsKey.set(ns, k)
		nodes.push({ key: k, label: ns, role: 'group', isContainer: true, icon: 'kubernetes' })
	}
	const keyOf = new Map<string, string>()
	const id = (kind: string, ns: string, name: string) => `${kind}/${ns}/${name}`
	const add = (kind: string, ns: string, name: string, want: string, n: Omit<ArchNode, 'key'>) => {
		const i = id(kind, ns, name)
		if (keyOf.has(i)) return keyOf.get(i)!
		const k = keys.take(want)
		keyOf.set(i, k)
		nodes.push({ key: k, parent: nsKey.get(ns), ...n })
		return k
	}

	const podLabels = new Map<string, Obj>()
	let cfgRefs = 0
	for (const w of workloads) {
		const { labels, spec } = podSpec(w)
		const rf = refs(spec)
		const t = rf.images.map(techForImage).find(Boolean) ?? null
		const replicas = asStr(asObj(w.doc.spec).replicas)
		const k = add(w.kind, w.ns, w.name, w.name, {
			label: w.name,
			icon: t?.icon ?? (w.kind === 'CronJob' || w.kind === 'Job' ? 'scheduler' : 'container'),
			shape: t?.shape,
			role: t?.role ?? 'service',
			tech: t?.tech,
			aliases: [w.name],
			facts: [w.kind, ...rf.images.map((i) => `image ${i}`), ...(replicas ? [`replicas ${replicas}`] : [])],
		})
		podLabels.set(k, labels)
		for (const cm of new Set(rf.configMaps)) {
			edges.push({ from: k, to: add('ConfigMap', w.ns, cm, `cm ${cm}`, { label: cm, icon: 'settings', shape: 'document', role: 'config' }), dotted: true })
			cfgRefs++
		}
		for (const s of new Set(rf.secrets)) {
			edges.push({ from: k, to: add('Secret', w.ns, s, `secret ${s}`, { label: s, icon: 'lock', role: 'config' }), dotted: true })
			cfgRefs++
		}
		for (const p of new Set(rf.pvcs)) edges.push({ from: k, to: add('PVC', w.ns, p, `pvc ${p}`, { label: p, icon: 'storage', shape: 'cylinder', role: 'store' }), plain: true })
	}

	let selected = 0
	const svcKeyByName = new Map<string, string>()
	for (const s of services) {
		const spec = asObj(s.doc.spec)
		const type = asStr(spec.type) ?? 'ClusterIP'
		const ports = asArr(spec.ports).map((p) => asStr(asObj(p).port)).filter(Boolean)
		const k = add('Service', s.ns, s.name, `svc ${s.name}`, { label: `${s.name} svc`, icon: type === 'LoadBalancer' ? 'load-balancer' : 'network', shape: 'hexagon', role: 'infra', facts: [`Service ${type}`, ...(ports.length ? [`ports ${ports.join(', ')}`] : [])] })
		svcKeyByName.set(`${s.ns}/${s.name}`, k)
		const sel = asObj(spec.selector)
		for (const w of workloads) {
			const wk = keyOf.get(id(w.kind, w.ns, w.name))!
			if (w.ns === s.ns && selects(sel, podLabels.get(wk) ?? {})) {
				edges.push({ from: k, to: wk, label: ports.length ? `:${ports.join(', :')}` : undefined })
				selected++
			}
		}
		if (type === 'LoadBalancer' || type === 'NodePort') edges.push({ from: 'Internet', to: k, label: type })
	}

	for (const ing of ingresses) {
		const spec = asObj(ing.doc.spec)
		const k = add('Ingress', ing.ns, ing.name, `ingress ${ing.name}`, { label: `${ing.name} ingress`, icon: 'router', role: 'infra', facts: ['Ingress'] })
		edges.push({ from: 'Internet', to: k, label: asArr(spec.rules).map((x) => asStr(asObj(x).host)).filter(Boolean).join(', ') || undefined })
		const backends: { svc: string; path?: string }[] = []
		const def = asObj(spec.defaultBackend ?? spec.backend)
		const defName = asStr(asObj(def.service).name) ?? asStr(def.serviceName)
		if (defName) backends.push({ svc: defName })
		for (const rule of asArr(spec.rules).map(asObj)) {
			for (const p of asArr(asObj(rule.http).paths).map(asObj)) {
				const b = asObj(p.backend)
				const name = asStr(asObj(b.service).name) ?? asStr(b.serviceName)
				if (name) backends.push({ svc: name, path: asStr(p.path) })
			}
		}
		const seen = new Map<string, string[]>()
		for (const b of backends) seen.set(b.svc, [...(seen.get(b.svc) ?? []), ...(b.path ? [b.path] : [])])
		for (const [svc, paths] of seen) {
			const target = svcKeyByName.get(`${ing.ns}/${svc}`) ?? add('Service', ing.ns, svc, `svc ${svc}`, { label: `${svc} svc`, icon: 'network', shape: 'hexagon', role: 'infra' })
			edges.push({ from: k, to: target, label: paths.length ? paths.slice(0, 3).join(' ') : undefined })
		}
	}

	for (const h of resources.filter((x) => x.kind === 'HorizontalPodAutoscaler')) {
		const spec = asObj(h.doc.spec)
		const t = asObj(spec.scaleTargetRef)
		const target = keyOf.get(id(asStr(t.kind) ?? 'Deployment', h.ns, asStr(t.name) ?? ''))
		if (!target) continue
		const min = asStr(spec.minReplicas)
		const max = asStr(spec.maxReplicas)
		const k = add('HPA', h.ns, h.name, `hpa ${h.name}`, { label: `${h.name} HPA`, icon: 'layers', role: 'infra', facts: [`replicas ${min ?? '1'}-${max ?? '?'}`] })
		edges.push({ from: k, to: target, label: max ? `${min ?? 1}–${max}` : 'scales', dotted: true })
	}

	if (edges.some((e) => e.from === 'Internet')) nodes.unshift({ key: 'Internet', icon: 'globe', shape: 'oval', role: 'client' })
	r.root = { nodes, edges }
	r.confidence = workloads.length ? 0.85 : 0.6
	r.notes.push(`${plural(workloads.length, 'workload')}, ${plural(services.length, 'Service')}, ${plural(ingresses.length, 'Ingress', 'Ingresses')} in ${plural(namespaces.length, 'namespace')}`)
	if (selected) r.notes.push(`${plural(selected, 'Service→workload link')} from label selectors`)
	if (cfgRefs) r.notes.push(`${plural(cfgRefs, 'ConfigMap/Secret reference')} (secret names only)`)
	return r
}
