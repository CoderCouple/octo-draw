import { Router } from 'express'
import { db } from '../db'
import { cache } from '../db/cache'
import type { User } from '@acme/shared'
export const usersRouter = Router()
usersRouter.get('/', async () => (await cache.get('u')) ?? db.query<User>('select 1'))
