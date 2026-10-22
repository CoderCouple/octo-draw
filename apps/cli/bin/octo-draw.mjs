#!/usr/bin/env node
// Runs the TypeScript sources directly through tsx (core ships as TS source).
import { register } from 'tsx/esm/api'

register()
const { main } = await import('../src/index.ts')
process.exitCode = await main(process.argv.slice(2))
