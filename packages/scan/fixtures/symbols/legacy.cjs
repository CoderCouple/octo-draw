'use strict'
const fs = require('fs')
const { join } = require('path')

function read(p) {
	return fs.readFileSync(join(__dirname, p), 'utf8')
}

const parse = (text) => JSON.parse(text)

class Store {
	constructor() {
		this.data = parse(read('x.json'))
	}
}

exports.version = '1'
module.exports = { read, parse, Store }
