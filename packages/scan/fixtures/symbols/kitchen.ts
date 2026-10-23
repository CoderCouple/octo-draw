// Every TS construct the extractor should see.
import defaultThing, { helper as h, type Shape, other } from './util'
import type { Options } from '../types'
import * as path from 'node:path'
import './side-effect'
export { reexported } from './re'
export * from './all'
export * as ns from './ns'

/* block comment: function fake() {} */
export const VERSION = '1.0' // const fake2 = 1

export interface Config extends Options, Shape {
	name: string
	retries?: number
	load(path: string): Promise<void>
	[key: string]: unknown
}

export type Mode = 'a' | 'b'
	| 'c'

type Pair<T> = { left: T; right: T }

export enum Color {
	Red,
	Green = 'green',
	Blue = 4,
}

const enum Flags { A = 1, B = 2 }

declare function legacy(x: number): string

export function compute(input: number): number {
	return square(input) + LIMIT
}

export function compute2(a: string): string
export function compute2(a: number): number
export function compute2(a: unknown): unknown {
	return a
}

function square(n: number): number {
	return n * n
}

const LIMIT = 10, OTHER = LIMIT * 2

export const handler = async (req: Config) => {
	const res = await h(req.name)
	return format`value ${compute(res)} ok`
}

const format = (s: TemplateStringsArray, ...v: unknown[]) => s.join('') + v.join('')

let counter = 0
var legacyVar = counter

export const { alpha, beta: gamma, ...restProps } = defaultThing()
const [first, second] = [1, 2]

export function* gen() {
	yield square(2)
}

@decorator()
export abstract class Base<T> implements Shape {
	abstract area(): number
	describe(): string {
		return `area ${this.area()}`
	}
}

export class Engine extends Base<number> {
	static instances = 0
	readonly id: string
	#secret = 42
	private cache = new Map<string, Pair<number>>()
	protected handle = (e: Event) => this.run(e)

	constructor(private readonly opts: Config, public name = 'x') {
		super()
		this.id = path.join('a', 'b')
		Engine.instances++
	}

	get size(): number {
		return this.cache.size
	}

	set size(v: number) {
		this.reset()
	}

	area(): number {
		return square(this.#secret)
	}

	async run(e?: Event): Promise<void> {
		this.#tick()
		await this.load()
		other(e)
	}

	load(): Promise<void>
	load(x?: string): Promise<void> {
		return Promise.resolve()
	}

	#tick() {
		this.cache.clear()
	}

	reset() {}

	static create(): Engine {
		return new Engine({ name: 'e' } as Config)
	}

	[Symbol.iterator]() {
		return [][Symbol.iterator]()
	}
}

namespace Internal {
	export const x = 1
}

function decorator() {
	return (t: unknown) => t
}

export default Engine

main()
