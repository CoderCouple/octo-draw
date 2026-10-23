import { Pool } from 'pg'

export const pool = new Pool()

export async function query(sql: string, params: unknown[] = []) {
	const r = await pool.query(sql, params)
	return r.rows
}
