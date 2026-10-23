import { Money } from '../money'
import { RATES } from './rates'

export function taxFor(m: Money, country: string): Money {
	return new Money(Math.round(m.cents * (RATES[country] ?? 0)), m.currency)
}
