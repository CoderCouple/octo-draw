import { readFile, writeFile } from 'node:fs/promises'
import { run, type IO } from './cli'

export { run, parseArgs, HELP, type IO } from './cli'
export { loadInput, convertDoc, type InputFormat, type OutputFormat } from './convert'

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = []
	for await (const c of process.stdin) chunks.push(c as Buffer)
	return Buffer.concat(chunks).toString('utf8')
}

export const nodeIO: IO = {
	readFile: (p) => readFile(p, 'utf8'),
	writeFile: (p, d) => writeFile(p, d, 'utf8'),
	readStdin,
	stdout: (t) => process.stdout.write(t),
	stderr: (t) => process.stderr.write(t),
	fetch: (...a) => fetch(...a),
	env: process.env,
}

export function main(argv: string[]): Promise<number> {
	return run(argv, nodeIO)
}
