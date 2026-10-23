import { Money, add } from '@shop/core'
import { query } from '../db'

export async function createOrder(req: { body?: { amount?: number } }) {
	const total = add(new Money(req.body?.amount ?? 0), new Money(5))
	await query('insert into orders values ($1)', [total.cents])
	return { total }
}
