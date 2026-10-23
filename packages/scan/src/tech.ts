/**
 * Technology → icon / role. Icon names always come from core's catalog
 * (`resolveIcon`, `searchIcons`), so every name we emit renders.
 */

import { ICON_CATALOG, resolveIcon, searchIcons, type NodeShape } from '@octo-draw/core'
import type { NodeRole } from './types'

const STORE_TAGS = new Set(['database', 'sql', 'nosql', 'cache', 'timeseries', 'olap', 'warehouse', 'storage', 'object', 'search', 'graph'])
const QUEUE_TAGS = new Set(['queue', 'stream', 'events', 'messaging', 'amqp'])

const byName = new Map(ICON_CATALOG.map((e) => [e.name, e]))

/** Words in image names that never identify a technology. */
const NOISE = new Set(['latest', 'alpine', 'slim', 'bullseye', 'bookworm', 'buster', 'official', 'library', 'docker', 'image', 'images', 'cp', 'bitnami', 'base', 'oss', 'community', 'edition', 'server', 'app', 'core', 'local', 'dev', 'node', 'stack', 'distroless'])

/** Extra image/product words the catalog does not carry as aliases. */
const EXTRA: Record<string, string> = {
	postgis: 'postgres',
	pgvector: 'postgres',
	timescaledb: 'timescale',
	localstack: 'aws',
	dynamodb: 'aws-dynamodb',
	'dynamodb-local': 'aws-dynamodb',
	mailhog: 'email',
	mailpit: 'email',
	smtp: 'email',
	keydb: 'redis',
	valkey: 'redis',
	dragonfly: 'redis',
	redpanda: 'kafka',
	zookeeper: 'zookeeper',
	'schema-registry': 'kafka',
	otel: 'opentelemetry',
	'otel-collector': 'opentelemetry',
	loki: 'logs',
	tempo: 'opentelemetry',
	httpd: 'apache',
	haproxy: 'load-balancer',
	pgadmin: 'postgres',
	adminer: 'database',
	mssql: 'sql-server',
	azurite: 'azure-blob-storage',
	'cloud-sql-proxy': 'gcp-cloud-sql',
	meilisearch: 'search',
	typesense: 'search',
	qdrant: 'database',
	weaviate: 'database',
	chroma: 'database',
	milvus: 'database',
}

export interface TechInfo {
	icon: string
	/** Canonical technology (the catalog name), used to merge the same store found by different analyzers. */
	tech: string
	role: NodeRole
	shape?: NodeShape
}

function info(icon: string): TechInfo | null {
	const r = resolveIcon(icon)
	if (!r) return null
	const name = byName.has(r.name) ? r.name : icon
	const e = byName.get(name)
	const tags = new Set([...(e?.tags ?? []), name])
	let role: NodeRole = 'external'
	if ([...tags].some((t) => STORE_TAGS.has(t))) role = 'store'
	else if ([...tags].some((t) => QUEUE_TAGS.has(t))) role = 'queue'
	return { icon: name, tech: name, role, shape: role === 'store' ? 'cylinder' : undefined }
}

/** Exact catalog name or alias (`postgresql` → `postgres`). */
export function techFor(word: string | undefined): TechInfo | null {
	if (!word) return null
	const w = word.toLowerCase().trim()
	if (!w) return null
	if (EXTRA[w]) return info(EXTRA[w])
	// only products (brands, vendor services), not generic concepts: an image called `api` or `report` is not a technology
	const hit = searchIcons(w, 3).find((h) => h.score >= 88 && isProduct(h.name))
	return hit ? info(hit.name) : null
}

function isProduct(name: string): boolean {
	const e = byName.get(name)
	return !!e && (!!e.slug || !!e.vendor || !!e.badge)
}

/**
 * Docker image → technology: `bitnami/postgresql:16`, `confluentinc/cp-kafka`,
 * `docker.elastic.co/elasticsearch/elasticsearch:8`, `redis/redis-stack`.
 */
export function techForImage(image: string | undefined): TechInfo | null {
	if (!image) return null
	const noTag = image.replace(/@sha256:[a-f0-9]+$/, '').replace(/:[^/:]+$/, '')
	const segs = noTag.toLowerCase().split('/')
	const last = segs[segs.length - 1]
	const candidates = [last, ...last.split(/[-_.]/), ...segs.slice(0, -1).reverse().flatMap((s) => [s, ...s.split(/[-_.]/)])]
	for (const c of candidates) {
		if (!c || NOISE.has(c) || /^\d/.test(c)) continue
		const t = techFor(c)
		if (t) return t
	}
	return null
}

/** Pretty label for a technology (`postgres` → `PostgreSQL`). */
export function techLabel(tech: string): string {
	return byName.get(tech)?.label ?? tech
}

export function iconExists(name: string): boolean {
	return resolveIcon(name) !== null
}
