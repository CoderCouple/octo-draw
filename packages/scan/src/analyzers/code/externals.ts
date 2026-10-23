/**
 * Dependency → external system. One data table for npm, Go modules, PyPI and
 * crates. `match` is an exact package name or a RegExp; the first row wins.
 * `system` is the node key (shared across packages, so two services using
 * Postgres point at one Postgres node), `icon` a core catalog name.
 */

import type { NodeShape } from '@octo-draw/core'

export interface ExternalSystem {
	system: string
	icon: string
	/** Canonical technology for merging with compose / k8s data stores. */
	tech?: string
	shape?: NodeShape
	kind: 'store' | 'queue' | 'external'
}

interface Row extends ExternalSystem {
	match: (string | RegExp)[]
}

const db = (system: string, icon: string, match: Row['match']): Row => ({ system, icon, tech: icon, shape: 'cylinder', kind: 'store', match })
const q = (system: string, icon: string, match: Row['match']): Row => ({ system, icon, tech: icon, kind: 'queue', match })
const ext = (system: string, icon: string, match: Row['match']): Row => ({ system, icon, kind: 'external', match })

export const EXTERNALS: Row[] = [
	// data stores
	db('Postgres', 'postgres', ['pg', 'postgres', 'pg-promise', 'slonik', '@neondatabase/serverless', '@vercel/postgres', 'github.com/lib/pq', /^github\.com\/jackc\/pgx/, 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg', 'tokio-postgres', 'postgres-types', 'diesel', 'pgvector']),
	db('Supabase', 'supabase', ['@supabase/supabase-js', '@supabase/ssr', 'supabase']),
	db('MySQL', 'mysql', ['mysql', 'mysql2', 'github.com/go-sql-driver/mysql', 'pymysql', 'mysqlclient', 'mysql-connector-python']),
	db('SQLite', 'sqlite', ['sqlite3', 'better-sqlite3', '@libsql/client', 'github.com/mattn/go-sqlite3', 'modernc.org/sqlite', 'rusqlite']),
	db('MongoDB', 'mongodb', ['mongodb', 'mongoose', 'go.mongodb.org/mongo-driver', 'pymongo', 'motor', 'mongodb-rust-driver']),
	db('Redis', 'redis', ['redis', 'ioredis', '@redis/client', '@upstash/redis', 'bullmq', 'bull', 'github.com/redis/go-redis/v9', /^github\.com\/go-redis\/redis/, 'github.com/gomodule/redigo', 'redis-py', 'aioredis', 'fred']),
	db('Elasticsearch', 'elasticsearch', ['@elastic/elasticsearch', 'elasticsearch', 'github.com/elastic/go-elasticsearch/v8', 'elasticsearch-py']),
	db('OpenSearch', 'opensearch', ['@opensearch-project/opensearch', 'opensearch-py']),
	db('DynamoDB', 'aws-dynamodb', ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb', 'github.com/aws/aws-sdk-go-v2/service/dynamodb', 'aws-sdk-dynamodb']),
	db('S3', 'aws-s3', ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner', 'github.com/aws/aws-sdk-go-v2/service/s3', 'aws-sdk-s3', 's3fs']),
	db('Cloud Storage', 'gcp-cloud-storage', ['@google-cloud/storage', 'cloud.google.com/go/storage', 'google-cloud-storage']),
	db('Firestore', 'gcp-firestore', ['@google-cloud/firestore', 'firebase-admin', 'google-cloud-firestore']),
	db('BigQuery', 'gcp-bigquery', ['@google-cloud/bigquery', 'google-cloud-bigquery', 'cloud.google.com/go/bigquery']),
	db('Azure Blob Storage', 'azure-blob-storage', ['@azure/storage-blob', 'azure-storage-blob']),
	db('Cosmos DB', 'azure-cosmos-db', ['@azure/cosmos', 'azure-cosmos']),
	db('ClickHouse', 'clickhouse', ['@clickhouse/client', 'clickhouse-connect', 'github.com/ClickHouse/clickhouse-go/v2']),
	db('Cassandra', 'cassandra', ['cassandra-driver', 'github.com/gocql/gocql', 'cassandra-driver-py']),
	db('Neo4j', 'neo4j', ['neo4j-driver', 'neo4j']),
	db('Snowflake', 'snowflake', ['snowflake-sdk', 'snowflake-connector-python']),
	db('Pinecone', 'database', ['@pinecone-database/pinecone', 'pinecone-client', 'pinecone']),
	db('Qdrant', 'database', ['@qdrant/js-client-rest', 'qdrant-client']),
	db('Memcached', 'memcached', ['memjs', 'memcached', 'pymemcache']),
	// ORMs map to the database named in config when they can't tell: Postgres is the common default
	db('Postgres', 'postgres', ['typeorm', '@prisma/client', 'prisma', 'drizzle-orm', 'kysely', 'knex', 'sequelize', '@mikro-orm/postgresql', 'sqlalchemy', 'gorm.io/driver/postgres', 'sqlx']),
	// queues & streams
	q('Kafka', 'kafka', ['kafkajs', '@confluentinc/kafka-javascript', 'node-rdkafka', 'github.com/segmentio/kafka-go', 'github.com/IBM/sarama', 'github.com/Shopify/sarama', /^github\.com\/confluentinc\/confluent-kafka-go/, 'kafka-python', 'confluent-kafka', 'aiokafka', 'rdkafka']),
	q('RabbitMQ', 'rabbitmq', ['amqplib', 'amqp-connection-manager', 'github.com/rabbitmq/amqp091-go', 'github.com/streadway/amqp', 'pika', 'aio-pika', 'lapin']),
	q('NATS', 'nats', ['nats', 'github.com/nats-io/nats.go', 'nats-py', 'async-nats']),
	q('SQS', 'aws-sqs', ['@aws-sdk/client-sqs', 'sqs-consumer', 'github.com/aws/aws-sdk-go-v2/service/sqs', 'aws-sdk-sqs']),
	q('SNS', 'aws-sns', ['@aws-sdk/client-sns', 'github.com/aws/aws-sdk-go-v2/service/sns']),
	q('EventBridge', 'aws-eventbridge', ['@aws-sdk/client-eventbridge']),
	q('Kinesis', 'aws-kinesis', ['@aws-sdk/client-kinesis']),
	q('Pub/Sub', 'gcp-pubsub', ['@google-cloud/pubsub', 'cloud.google.com/go/pubsub', 'google-cloud-pubsub']),
	q('Service Bus', 'azure-service-bus', ['@azure/service-bus', 'azure-servicebus']),
	q('Celery', 'celery', ['celery']),
	// AI
	ext('LLM API', 'anthropic', ['@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk', 'anthropic', '@ai-sdk/anthropic', 'github.com/anthropics/anthropic-sdk-go']),
	ext('OpenAI API', 'openai', ['openai', '@ai-sdk/openai', 'github.com/sashabaranov/go-openai', 'github.com/openai/openai-go', 'async-openai']),
	ext('Gemini API', 'gemini', ['@google/generative-ai', '@google/genai', 'google-generativeai', 'google-genai']),
	ext('Bedrock', 'aws-bedrock', ['@aws-sdk/client-bedrock-runtime', '@ai-sdk/amazon-bedrock']),
	ext('Mistral API', 'mistral', ['@mistralai/mistralai', 'mistralai']),
	ext('Hugging Face', 'huggingface', ['@huggingface/inference', 'huggingface_hub', 'transformers']),
	ext('Ollama', 'ollama', ['ollama']),
	// SaaS
	ext('Stripe', 'stripe', ['stripe', '@stripe/stripe-js', 'github.com/stripe/stripe-go/v76', /^github\.com\/stripe\/stripe-go/, 'async-stripe']),
	ext('PayPal', 'paypal', ['@paypal/checkout-server-sdk', '@paypal/paypal-js']),
	ext('Twilio', 'twilio', ['twilio']),
	ext('SendGrid', 'sendgrid', ['@sendgrid/mail', 'sendgrid']),
	ext('Email (SMTP)', 'email', ['nodemailer', 'resend', 'postmark', '@aws-sdk/client-ses', '@aws-sdk/client-sesv2']),
	ext('Slack', 'slack', ['@slack/web-api', '@slack/bolt', 'slack-sdk', 'slack_sdk']),
	ext('Discord', 'discord', ['discord.js', 'discord.py']),
	ext('GitHub API', 'github', ['@octokit/rest', '@octokit/core', 'octokit', 'PyGithub', 'github.com/google/go-github/v60']),
	ext('Auth0', 'auth0', ['auth0', '@auth0/nextjs-auth0', '@auth0/auth0-react']),
	ext('Clerk', 'auth', ['@clerk/nextjs', '@clerk/clerk-sdk-node', '@clerk/backend']),
	ext('Firebase', 'firebase', ['firebase']),
	ext('Sentry', 'sentry', ['@sentry/node', '@sentry/react', '@sentry/nextjs', '@sentry/browser', 'sentry-sdk', 'github.com/getsentry/sentry-go']),
	ext('Datadog', 'datadog', ['dd-trace', 'datadog', 'ddtrace']),
	ext('OpenTelemetry', 'opentelemetry', ['@opentelemetry/sdk-node', '@opentelemetry/api', 'opentelemetry-sdk', 'go.opentelemetry.io/otel']),
	ext('Cognito', 'aws-cognito', ['@aws-sdk/client-cognito-identity-provider', 'amazon-cognito-identity-js']),
	ext('Secrets Manager', 'aws-secrets-manager', ['@aws-sdk/client-secrets-manager']),
	ext('AWS Lambda', 'aws-lambda', ['@aws-sdk/client-lambda']),
	ext('AWS', 'aws', ['aws-sdk', 'boto3', 'botocore', 'github.com/aws/aws-sdk-go']),
	ext('Algolia', 'search', ['algoliasearch']),
	ext('Pusher', 'socketio', ['pusher', 'pusher-js']),
	ext('Vercel', 'vercel', ['@vercel/analytics', '@vercel/blob', '@vercel/kv']),
	ext('Cloudflare', 'cloudflare', ['wrangler', '@cloudflare/workers-types']),
]

const exact = new Map<string, Row>()
const patterns: Row[] = []
for (const row of EXTERNALS) {
	for (const m of row.match) {
		if (typeof m === 'string') {
			if (!exact.has(m.toLowerCase())) exact.set(m.toLowerCase(), row)
		} else if (!patterns.includes(row)) patterns.push(row)
	}
}

/** External system a dependency points at, or null. */
export function externalFor(dep: string): ExternalSystem | null {
	const row = exact.get(dep.toLowerCase()) ?? patterns.find((r) => r.match.some((m) => typeof m !== 'string' && m.test(dep)))
	if (!row) return null
	const { match: _m, ...sys } = row
	return sys
}
