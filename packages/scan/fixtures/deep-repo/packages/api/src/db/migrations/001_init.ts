import { query } from '..'

export async function up() {
	await query('create table users (id text primary key, name text)')
}
