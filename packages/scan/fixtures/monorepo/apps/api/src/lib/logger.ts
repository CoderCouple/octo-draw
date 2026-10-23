import { Kafka } from 'kafkajs'
import { S3Client } from '@aws-sdk/client-s3'
export const logger = { info: (m: string) => console.log(m), kafka: new Kafka({ brokers: [] }), s3: new S3Client({}) }
