import { describe, expect, it } from 'vitest'
import type { DiagramIR } from '../ir'
import { parseOcto } from './parse'
import { printOcto } from './print'

const SRC = `erd
title Blog
notation crows-feet
users [icon: user, color: blue] {
	id string pk
	email string unique
	teamId string fk
}
teams [icon: users] {
	id string pk
	name string
}
posts {
	id string pk
	authorId string fk
	"published at" timestamp
}
tags
users.teamId > teams.id: member of
users.id < posts.authorId
posts <> tags [id: post-tags]
users.id - profiles.userId
`

const strip = (ir: DiagramIR): unknown => JSON.parse(JSON.stringify(ir, (k, v) => (k === 'span' ? undefined : v)))

describe('erd DSL', () => {
	it('parses entities, fields and relationships with cardinality', () => {
		const { ir, diagnostics } = parseOcto(SRC)
		expect(diagnostics).toEqual([])
		expect(ir.kind).toBe('erd')
		expect(ir.direction).toBe('right')
		expect(ir.erd).toEqual({ notation: 'crows-feet' })
		const users = ir.nodes.find((n) => n.key === 'users')!
		expect(users.icon).toBe('user')
		expect(users.fields).toEqual([
			{ name: 'id', type: 'string', meta: ['pk'] },
			{ name: 'email', type: 'string', meta: ['unique'] },
			{ name: 'teamId', type: 'string', meta: ['fk'] },
		])
		expect(ir.nodes.find((n) => n.key === 'posts')!.fields![2]).toEqual({ name: 'published at', type: 'timestamp' })
		expect(ir.edges[0]).toMatchObject({ from: 'users', to: 'teams', fromField: 'teamId', toField: 'id', cardinality: 'n-1', label: 'member of', key: 'users->teams#0' })
		expect(ir.edges[1]).toMatchObject({ from: 'users', to: 'posts', cardinality: '1-n' })
		expect(ir.edges[2]).toMatchObject({ key: 'post-tags', cardinality: 'n-n' })
		expect(ir.edges[2].fromField).toBeUndefined()
		// implicit entity + attribute
		expect(ir.nodes.find((n) => n.key === 'profiles')!.fields).toEqual([{ name: 'userId' }])
		expect(ir.edges[3].cardinality).toBe('1-1')
	})

	it('round-trips through printOcto', () => {
		const a = parseOcto(SRC).ir
		const printed = printOcto(a)
		const b = parseOcto(printed)
		expect(b.diagnostics).toEqual([])
		expect(strip(b.ir)).toEqual(strip(a))
		expect(printOcto(b.ir)).toBe(printed)
	})

	it('keeps flowcharts unaffected by erd keywords', () => {
		const { ir } = parseOcto('notation > users.id')
		expect(ir.kind).toBe('flowchart')
		expect(ir.edges[0]).toMatchObject({ from: 'notation', to: 'users.id' })
	})

	it('reports problems without throwing', () => {
		const { diagnostics } = parseOcto('erd\nnotation uml\nusers {\n id string\n')
		expect(diagnostics.map((d) => d.severity)).toEqual(['warning', 'error'])
		expect(parseOcto('erd\n> x').diagnostics[0].severity).toBe('error')
	})
})
