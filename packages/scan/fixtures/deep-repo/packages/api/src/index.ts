import { Server } from './server'

const server = new Server()
server.start(Number(process.env.PORT ?? 3000))
