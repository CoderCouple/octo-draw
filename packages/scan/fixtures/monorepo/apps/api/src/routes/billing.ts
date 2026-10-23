import Stripe from 'stripe'
import Anthropic from '@anthropic-ai/sdk'
import { Router } from 'express'
import { db } from '../db/index.js'
const stripe = new Stripe('sk_test')
const claude = new Anthropic()
export const billingRouter = Router()
