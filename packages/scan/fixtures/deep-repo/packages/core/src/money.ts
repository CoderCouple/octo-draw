export type Amount = number

export interface Currency {
	code: string
	digits: number
}

export const USD: Currency = { code: 'USD', digits: 2 }

export class Money {
	constructor(public readonly cents: Amount, public readonly currency: Currency = USD) {}

	plus(other: Money): Money {
		return new Money(this.cents + other.cents, this.currency)
	}

	format(): string {
		return `${this.currency.code} ${(this.cents / 10 ** this.currency.digits).toFixed(this.currency.digits)}`
	}
}

export function add(a: Money, b: Money): Money {
	return a.plus(b)
}
