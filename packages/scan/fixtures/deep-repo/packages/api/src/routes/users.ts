import { query } from '../db'

export interface User {
	id: string
	name: string
}

export async function listUsers(): Promise<User[]> {
	return (await query('select * from users')) as User[]
}

export async function getUser(req: { params?: { id?: string } }): Promise<User | undefined> {
	const all = await listUsers()
	return all.find((u) => u.id === req.params?.id)
}
