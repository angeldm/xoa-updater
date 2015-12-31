import * as format from '@julien-f/json-rpc/format'
import Bluebird from 'bluebird'
import logSymbols from 'log-symbols'
import parse from '@julien-f/json-rpc/parse'
import {AlreadyRegistered, AlreadyUnderTrial, AuthenticationFailed, ResourceNotFound, ServerNotReached, TrialAlreadyConsumed, TrialUnavailabe, xoaUpdater} from './xoa-updater'
import {exec} from 'child_process'
import {JsonRpcError, MethodNotFound} from '@julien-f/json-rpc/errors'
import {load as loadConfig} from 'app-conf'
import {Server as WebSocketServer} from 'ws'

const execAsync = Bluebird.promisify(exec)

const appName = 'xoa-updater'

let lock = Bluebird.resolve()

function getLock () {
  let releaseLock
  let released = false
  const gotLock = lock
  lock = new Bluebird((resolve, reject) => {
    releaseLock = (tag = '') => {
      if (!released) {
        // console.log('releaseLock ' + tag)
        released = true
        resolve()
      } else {
        throw new Error('Lock already released')
      }
    }
  })
  return gotLock.return(releaseLock)
}

function onMessage ({type, method, params}) {
  if (method.substring(0, 1) === '_' || xoaUpdater[method] === undefined && xoaUpdater['jsonrpc_' + method] === undefined) {
    throw new MethodNotFound(method)
  }
  xoaUpdater['jsonrpc_' + method] !== undefined && (method = 'jsonrpc_' + method)
  return xoaUpdater[method].call(xoaUpdater, params)
}

function main () {
  return loadConfig(appName)
  .then(config => {
    const wss = new WebSocketServer({port: config.updaterPort})
    console.log('Server listening on ' + config.updaterPort)
    // wss.on('error', error => console.log('SERVER', error))
    wss.on('connection', socket => {
      socket.secureSend = (...args) => {
        try {
          socket.send(...args)
        } catch(err) {
          console.log('Could not notify client: ' + err.message)
        }
      }
      // socket.on('error', error => console.log('SOCKET', error))
      // socket.on('error', function (error) {
      //   console.error(error)
      //   socket.emit('server-error', error.message)
      // })
      socket.send(JSON.stringify(format.notification('connected', {message: 'Successfully connected to xoa-updater-service'})))
      socket.on('message', function (data, flags) {
        const message = parse(String(data))
        if (message.method === 'update') {
          return getLock()
          .then(releaseLock => {
            // console.log('getLock')
            const printLstnr = content => socket.secureSend(JSON.stringify(format.notification('print', {content})))
            const endLstnr = end => {
              clean('OK')
              return Bluebird.resolve()
              .then(() => {
                if (end.state === 'updater-upgraded') {
                  return execAsync('systemctl is-active xoa-updater.service')
                  .catch(() => {
                    socket.secureSend(JSON.stringify(format.notification('end', {level: 'info', message: 'xoa-updater service will now shutdown and will have to be restarted manually.'})))
                    wss.close()
                    process.exit(0)
                  })
                  .then(() => execAsync('systemctl restart xoa-updater'))
                  .catch(error => {
                    console.log(logSymbols.warning, error.message)
                    socket.secureSend(JSON.stringify(format.notification('warning', {level: 'warning', message: error.message})))
                  })
                }
              })
              .finally(() => socket.secureSend(JSON.stringify(format.notification('end', end))))
            }
            const clean = (tag = '') => {
              xoaUpdater.removeListener('print', printLstnr)
              xoaUpdater.removeListener('end', endLstnr)
              releaseLock('CLEAN-' + tag)
            }
            xoaUpdater.on('print', printLstnr)
            xoaUpdater.on('end', endLstnr)
            onMessage(message)
            .catch(error => {
              socket.secureSend(JSON.stringify(format.notification('server-error', {message: error.message})))
              clean('ERROR')
            })
            .catch(error => {
              console.log('Client connection lost : ' + error.message)
              clean('ERROR')
            })
          })
        } else {
          return onMessage(message)
          .then(response => {
            return socket.secureSend(JSON.stringify(format.response(message.id, response)))
          })
          .catch(AuthenticationFailed, error => {
            throw new JsonRpcError(error.message, 1)
          })
          .catch(AlreadyRegistered, AlreadyUnderTrial, ResourceNotFound, ServerNotReached, TrialAlreadyConsumed, TrialUnavailabe, error => {
            throw new JsonRpcError(error.message, 99)
          })
          .catch(error => {
            return socket.secureSend(JSON.stringify(format.error(message.id, error)))
          })
          .catch(error => console.log('Client connection lost : ' + error.message))
        }
      })
    })
  })
}

export default main

if (!module.parent) {
  main()
}
