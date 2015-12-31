#!/usr/bin/env node
'use strict'

require('babel/register')({
  ignore: /xoa-.*\/node_modules/
})
var Bluebird = require('bluebird')
var logSymbols = require('log-symbols')

var xoaUpdater = require('./cli').xoaUpdater
module.exports = xoaUpdater

if (!module.parent) {
  Bluebird.try(xoaUpdater)
  .then(function (response) {
    console.log()
    console.log(logSymbols[response.level], response.message)
    console.log()
  })
  .catch(function (err) {
    console.log()
    console.error(logSymbols.error, err.message)
    console.log()
  })
}
