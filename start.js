#!/usr/bin/env node
'use strict'

require('babel/register')({
  ignore: /xoa-.*\/node_modules/
})

var server = require('./server')
module.exports = server

if (!module.parent) {
  server()
}
