'use strict'

var fse = require('fs-extra')
var Bluebird = require('bluebird')
var exec = require('child_process').exec

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
  .then(function () {
    return fse.unlinkAsync('/var/lib/xoa-updater/registration.json').catch(noop)
  })
}

remove()
