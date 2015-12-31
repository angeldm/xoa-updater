#!/usr/bin/env babel-node

import * as format from '@julien-f/json-rpc/format'
import Bluebird from 'bluebird'
import inquirer from 'inquirer'
import logSymbols from 'log-symbols'
import parse from '@julien-f/json-rpc/parse'
import WebSocket from 'ws'
import {EventEmitter} from 'events'
import {load as loadConfig} from 'app-conf'

Bluebird.promisifyAll(inquirer)

const appName = 'xoa-updater'

function prepareSocket (url) {
  const socket = new WebSocket(url)
  socket.sendAsync = Bluebird.promisify(socket.send)
  return socket
}

function request (socket, method, params = {}) {
  const req = format.request(method, params)
  const reqId = req.id
  return socket.sendAsync(JSON.stringify(req))
  .then(() => {
    let resolver, rejecter
    const promise = new Bluebird((resolve, reject) => {
      resolver = resolve
      rejecter = reject
    })
    const handleResponse = message => {
      const {type, id, result, error} = parse(message)
      if (type === 'response' && id === reqId && result !== undefined) {
        resolver(result)
      } else if (type === 'error' && id === reqId && error !== undefined) {
        rejecter(error)
      } else if (id === reqId) {
        rejecter(new Error('Unexpected response'))
      }
      promise.isPending() || socket.removeListener('message', handleResponse)
    }
    socket.on('message', handleResponse)
    return promise
  })
}

function notify (socket, method, params = {}) {
  return socket.sendAsync(JSON.stringify(format.notification(method, params)))
}

function registerToken (socket, renew = false) {
  const questions = [
    {
      type: 'input',
      name: 'email',
      message: 'Email:'
    },
    {
      type: 'password',
      name: 'password',
      message: 'Password:'
    }
  ]

  return new Bluebird(function (resolve) {
    inquirer.prompt(questions, resolve)
  })
  .then(answers => {
    renew && (answers.renew = renew)
    return request(socket, 'register', answers)
  })
  .catch(err => err.code === 1, err => {
    // Authentication failed
    console.log(logSymbols.error, err.message)
    return registerToken(socket)
  })
}

function isRegistered (socket) {
  return request(socket, 'isRegistered')
}

const register = Bluebird.coroutine(function * (force = false) {
  const config = yield loadConfig(appName)
  const socket = prepareSocket('ws://localhost:' + config.updaterPort)
  const middle = new EventEmitter()
  const close = () => {
    middle.removeAllListeners()
    socket.removeAllListeners()
    socket.terminate()
  }

  let resolver, rejecter
  const promise = new Bluebird((resolve, reject) => {
    resolver = resolve
    rejecter = reject
  })
  socket.on('message', message => {
    message = parse(message)
    middle.emit(message.method, message.params)
  })
  socket.on('close', function () {
    close()
    rejecter(new Error('Disconnected from xoa-updater service'))
  })
  socket.on('error', function (error) {
    close()
    rejecter(error)
  })

  middle.on('server-error', function (error) {
    close()
    rejecter(new Error(error.message))
  })
  middle.on('connected', function ({message}) {
    console.log(message)

    const _register = (renew = false) => {
      console.log()
      console.log('Please enter your xen-orchestra.com identifiers to register your XOA:')
      return registerToken(socket, renew)
      .then(() => resolver({level: 'info', message: 'Your Xen Orchestra Appliance has been succesfully registered'}))
    }

    return isRegistered(socket)
    .then(registered => {
      if (registered.registrationToken !== undefined) {
        let promise
        if (force) {
          const questions = [
            {
              type: 'input',
              name: 'renew',
              message: 'Your XOA is already registered, do you really want to force a new registration (yes/NO)?:'
            }
          ]
          promise = new Bluebird(function (resolve) {
            inquirer.prompt(questions, resolve)
          })
        } else {
          promise = Bluebird.resolve({renew: 'no'})
        }

        return promise
        .then(answers => {
          if (answers.renew && answers.renew.search(/^yes$/i) !== -1) {
            return _register(true)
          } else {
            resolver({level: 'info', message: 'Your XOA is already registered'})
          }
        })
      } else {
        return _register()
      }
    })
    .catch(error => rejecter(error))
    .finally(close)
  })
  return promise
})

const update = Bluebird.coroutine(function * (upgrade = false, url = undefined, forceToken = undefined) {
  const config = yield loadConfig(appName)
  const socket = prepareSocket('ws://localhost:' + config.updaterPort)
  const middle = new EventEmitter()
  const close = () => {
    middle.removeAllListeners()
    socket.removeAllListeners()
    socket.terminate()
  }

  let resolver, rejecter
  const promise = new Bluebird((resolve, reject) => {
    resolver = resolve
    rejecter = reject
  })

  socket.on('message', message => {
    message = parse(message)
    middle.emit(message.method, message.params)
  })
  socket.on('close', function () {
    close()
    rejecter(new Error('Disconnected from xoa-updater service'))
  })
  socket.on('error', function (error) {
    close()
    rejecter(error)
  })

  middle.on('connected', function ({message}) {
    console.log(message)
    notify(socket, 'update', {upgrade, url, forceToken})
    .catch(error => {
      close()
      rejecter(error)
    })
  })
  middle.on('print', function ({content}) {
    console.log(...content)
  })
  middle.on('end', function (end) {
    close()
    resolver(end)
  })
  middle.on('warning', function (warning) {
    console.log(logSymbols.warning, warning.message)
  })
  middle.on('server-error', function (error) {
    close()
    rejecter(new Error(error.message))
  })

  return promise
})

function usage () {
  console.log('xoa-updater usage:')
  console.log()
  console.log('xoa-updater-start\tRun xoa-updater service (will require internet access on usage)')
  console.log('xoa-updater\tCheck for updates')
  console.log('\tOptions:')
  console.log('\t--help\tDisplay this help')
  console.log('\t--register\tRegister your XO appliance on xen-orchestra.com')
  console.log('\t\t--force\tOverride an existing registration')
  console.log('\t--upgrade\tApply updates when found')
}

const main = Bluebird.coroutine(function * () {
  const argv = process.argv.slice(2)
  let index
  const upgradeOpt = (index = argv.indexOf('--upgrade')) !== -1
  upgradeOpt && argv.splice(index, 1)
  const registerOpt = (index = argv.indexOf('--register')) !== -1
  registerOpt && argv.splice(index, 1)
  const forceOpt = (index = argv.indexOf('--force')) !== -1
  forceOpt && argv.splice(index, 1)
  const helpOpt = (index = argv.indexOf('--help')) !== -1
  helpOpt && argv.splice(index, 1)
  let forceToken
  const tokenOpt = (index = argv.indexOf('--token')) !== -1
  tokenOpt && argv.splice(index, 1) && (forceToken = argv[index]) && argv.splice(index, 1)
  let url
  const urlOpt = (index = argv.indexOf('--url')) !== -1
  urlOpt && argv.splice(index, 1) && (url = argv[index]) && argv.splice(index, 1)
  if (helpOpt || argv.length > 0) {
    usage()
    return {
      level: 'info',
      message: 'END'
    }
  }

  try {
    if (registerOpt) {
      if (upgradeOpt) {
        console.log(logSymbols.warning, '--upgrade option ignored')
      }
      if (tokenOpt || forceToken) {
        console.log(logSymbols.warning, '--token option ignored')
      }
      if (urlOpt) {
        console.log(logSymbols.warning, '--url option ignored')
      }
      return yield register(forceOpt)
    } else {
      if (forceOpt) {
        console.log(logSymbols.warning, '--force option ignored')
      }
      return yield update(upgradeOpt, url, forceToken)
    }
  } catch (err) {
    if (err.message && err.message.search('not open') !== -1 || err.code === 'ECONNREFUSED') {
      return {
        level: 'warning',
        message: 'Your xoa-updater service may not be running. Use xoa-updater-start to run it.'
      }
    } else {
      throw err
    }
  }
})

export var xoaUpdater = main

if (!module.parent) {
  Bluebird.try(main)
  .then(response => {
    console.log()
    console.log(logSymbols[response.level], response.message)
    console.log()
  })
  .catch(err => {
    console.log()
    console.error(logSymbols.error, err.message)
    console.log()
  })
}
