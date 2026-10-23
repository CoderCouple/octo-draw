import express from 'express'
import { listUsers, getUser } from './routes/users'
import { createOrder } from './routes/orders'

export class Server {
	private app = express()
	private started = false

	start(port: number) {
		this.routes()
		this.app.listen(port)
		this.started = true
		this.log(`listening on ${port}`)
	}

	routes() {
		this.app.get('/users', (req, res) => this.handle(req, res, listUsers))
		this.app.get('/users/:id', (req, res) => this.handle(req, res, getUser))
		this.app.post('/orders', (req, res) => this.handle(req, res, createOrder))
	}

	async handle(req: unknown, res: { json(v: unknown): void }, fn: (req: unknown) => Promise<unknown>) {
		res.json(await fn(req))
	}

	private log(msg: string) {
		if (this.started) console.log(msg)
	}
}
