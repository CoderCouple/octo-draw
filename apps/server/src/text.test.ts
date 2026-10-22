import { describe, expect, it } from 'vitest'
import { FenceFilter, stripFences } from './text'

describe('stripFences', () => {
	it('leaves plain code alone', () => {
		expect(stripFences('A > B\n')).toBe('A > B')
	})
	it('strips a fenced block with a language tag', () => {
		expect(stripFences('```octo\nA > B\nB > C\n```')).toBe('A > B\nB > C')
	})
	it('takes the fenced body when there is prose around it', () => {
		expect(stripFences('Here you go:\n```\nA > B\n```\nEnjoy')).toBe('A > B')
	})
	it('handles an unterminated fence', () => {
		expect(stripFences('```eraser\nA > B')).toBe('A > B')
	})
})

function run(chunks: string[]): string {
	const f = new FenceFilter()
	return chunks.map((c) => f.push(c)).join('') + f.flush()
}

describe('FenceFilter', () => {
	it('passes through unfenced streams', () => {
		expect(run(['A >', ' B\nB > ', 'C'])).toBe('A > B\nB > C')
	})
	it('removes opening and closing fences split across chunks', () => {
		expect(run(['`', '``oc', 'to\nA > B\n', 'C > D\n`', '``'])).toBe('A > B\nC > D\n')
	})
	it('drops anything after the closing fence', () => {
		expect(run(['```\nA > B\n```\nThat is all.'])).toBe('A > B\n')
	})
	it('keeps backticks inside a line', () => {
		expect(run(['A > B: ', '`x`\n'])).toBe('A > B: `x`\n')
	})
})
