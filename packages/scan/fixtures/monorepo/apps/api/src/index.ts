import express from 'express'
import { usersRouter } from './routes/users'
import { billingRouter } from './routes/billing'
import { logger } from './lib/logger'

// docs: run it and open http://localhost:9999 (comment must not count)
const app = express()
app.use('/users', usersRouter)
app.use('/billing', billingRouter)
const PORT = Number(process.env.PORT ?? 4000)
app.listen(PORT, () => logger.info(`listening on ${PORT}`))
