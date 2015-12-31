'use strict'

var fse = require('fs-extra')
var Bluebird = require('bluebird')
var exec = require('child_process').exec
var logSymbols = require('log-symbols')

Bluebird.promisifyAll(fse)
var execAsync = Bluebird.promisify(exec)

var noop = function () {}

var remove = function () {
  return execAsync('systemctl stop xoa-updater.service').catch(noop)
  .then(function () {
    return execAsync('systemctl disable xoa-updater.service').catch(noop)
  })
  .then(function () {
    return fse.unlinkAsync('/etc/systemd/system/xoa-updater.service').catch(noop)
  })
  .then(function () {
    return execAsync('systemctl --system daemon-reload').catch(noop)
  })
}

remove()
.then(function () {
  return fse.ensureDirAsync('/etc/xoa-updater')
  .then(function () {
    return fse.ensureDirAsync('/var/lib/xoa-updater')
  })
  .then(function () {
    return fse.symlinkAsync('/usr/local/lib/node_modules/xoa-updater/production.config.json', '/etc/xoa-updater/config.updater.json').catch(noop)
  })
  .catch(function (error) {
    throw new Error('xoa-updater did not setup configuration correctly : ' + String(error))
  })
})
.then(function () {
  return fse.copyAsync('/usr/local/lib/node_modules/xoa-updater/xoa-updater.service', '/etc/systemd/system/xoa-updater.service') // TODO fix first path
  .then(function () {
    return fse.chmodAsync('/etc/systemd/system/xoa-updater.service', '0555')
  })
  .then(function () {
    return execAsync('systemctl --system daemon-reload')
  })
  .then(function () {
    return execAsync('systemctl enable xoa-updater.service')
  })
  .then(function () {
    return execAsync('systemctl start xoa-updater.service')
  })
  .catch(function (error) {
    throw new Error('xoa-updater-service has not set up correctly : ' + String(error))
  })
})
.catch(function (error) {
  console.error(logSymbols.error, error.message)
})
