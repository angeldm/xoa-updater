#!/usr/bin/env babel-node

import * as format from '@julien-f/json-rpc/format'
import _assign from 'lodash.assign'
import _forEach from 'lodash.foreach'
import _has from 'lodash.has'
import _pick from 'lodash.pick'
import Bluebird from 'bluebird'
import chalk from 'chalk'
import fse from 'fs-extra'
import hashFiles from 'hash-files'
import logSymbols from 'log-symbols'
import makeError from 'make-error'
import migrate from 'migrate'
import request from 'request'
import semver from 'semver'
import {EventEmitter} from 'events'
import {exec} from 'child_process'
import {load as loadConfig} from 'app-conf'

Bluebird.promisifyAll(fse)
Bluebird.promisifyAll(request)

const execAsync = Bluebird.promisify(exec)
const hashFilesAsync = Bluebird.promisify(hashFiles)

export const AlreadyRegistered = makeError('AlreadyRegistered')
export const AlreadyUnderTrial = makeError('AlreadyUnderTrial')
export const AuthenticationFailed = makeError('AuthenticationFailed')
export const HostNotFound = makeError('HostNotFound')
export const NotRegistered = makeError('NotRegistered')
export const ProxyAuthFailed = makeError('ProxyAuthFailed')
export const RequestNotAllowed = makeError('RequestNotAllowed')
export const ResourceNotFound = makeError('ResourceNotFound')
export const ServerNotReached = makeError('ServerNotReached')
export const TrialAlreadyConsumed = makeError('TrialAlreadyConsumed')
export const TrialUnavailabe = makeError('TrialUnavailabe')

const appName = 'xoa-updater'

class XoaUpdater extends EventEmitter {
  constructor () {
    this.update = Bluebird.coroutine(function * (upgrade = false, url = undefined, forceToken = undefined) {
      const overrideConf = {}
      url && (overrideConf.updateUrl = url)
      const config = yield this._getConfig(overrideConf)

      let registrationToken
      if (forceToken) {
        registrationToken = forceToken
      } else {
        const token = yield this._getRegistrationToken()
        registrationToken = token.registrationToken
      }
      if (!registrationToken) {
        return this._end({
          level: 'warning',
          message: 'Your appliance is not registered, take time to register first.',
          state: 'register-needed'
        })
      }

      const localManifest = yield this._getLocalManifest(config)

      console.log()
      let display = 'Checking new versions...'
      process.stdout.write(display + '\r')
      let manifest
      try {
        manifest = yield this._getManifest(config.updateUrl, registrationToken)
      } catch(err) {
        return this._end({
          level: 'error',
          message: err.message,
          state: 'error'
        })
      }
      display += 'ok ' + logSymbols.success
      this._print(display)

      // Upgrade important packages prior to anything
      const important = ['installer', 'updater']
      let namespaceToUpgrade
      _forEach(important, namespace => {
        namespaceToUpgrade = this._checkNamespace(localManifest, manifest, namespace)
        if (namespaceToUpgrade) {
          return false // Get out of the loop, we have found a namespace to upgarde immediatly
        }
      })
      if (namespaceToUpgrade) {
        if (upgrade) {
          yield this._getMigrations(localManifest, manifest, config, registrationToken)
          yield this._upgradeNamespace(localManifest, manifest, config, registrationToken, namespaceToUpgrade)
          yield this._saveManifest(config, localManifest, manifest, namespaceToUpgrade)

          return this._end({
            level: 'success',
            message: namespaceToUpgrade + ' has been successfully upgraded, xoa-updater can be ' + chalk.bold.bgGreen('run again') + '.',
            state: 'updater-upgraded'
          })
        } else {
          return this._end({
            level: 'info',
            message: namespaceToUpgrade + ' may be ' + chalk.bold.bgGreen('upgraded'),
            state: 'updater-upgrade-needed'
          })
        }
      }

      const trialChange = localManifest.trial !== manifest.trial
      if (trialChange) {
        if (manifest.trial) {
          this._print('Your XOA will be modified on benefit of a trial period.')
        } else {
          this._print('Your XOA shall be modified as a trial period comes to end.')
        }
      }

      const newPackages = this._findNewPackages(localManifest.npm, manifest.npm)
      const newVersions = this._findNewPckgVersions(localManifest.npm, manifest.npm)
      const packagesToRemove = this._findSuppressedPackages(localManifest.npm, manifest.npm)

      if (Object.keys(newPackages).length) {
        this._print('New packages available:')
        for (let key in newPackages) {
          this._print('  ' + chalk.blue(key + ' ' + newPackages[key]))
        }
      }

      if (Object.keys(newVersions).length) {
        this._print('New versions available:')
        for (let key in newVersions) {
          this._print('  ' + key + ' ' + chalk.blue(newVersions[key]))
        }
      }

      if (Object.keys(packagesToRemove).length) {
        this._print('Following packages will be removed:')
        for (let key in packagesToRemove) {
          this._print('  ' + chalk.yellow(key + ' ' + packagesToRemove[key]))
        }
      }

      if ((!(Object.keys(newVersions).length + Object.keys(newPackages).length + Object.keys(packagesToRemove).length)) && !trialChange) {
        return this._end({
          level: 'info',
          message: 'All up to date',
          state: 'xoa-up-to-date'
        })
      }

      if (!upgrade) {
        return this._end({
          level: 'info',
          message: 'xoa-updater may be run again to ' + chalk.bold.bgGreen('upgrade') + ' packages',
          state: 'xoa-upgrade-needed'
        })
      }

      console.log()
      const tmpFolder = this._generateTmpFolder(config.pckgDir)
      yield fse.ensureDirAsync(tmpFolder)
      try {
        const newInstalls = _assign({}, newPackages, newVersions)
        let pName

        yield this._getMigrations(localManifest, manifest, config, registrationToken)

        let installKeys = Object.keys(newInstalls)
        if (installKeys.length) {
          this._print('Downloading packages...')
          while ((pName = installKeys.pop())) {
            yield this._getPackage(
              config.updateUrl + '/downloads',
              registrationToken,
              pName,
              newInstalls[pName],
              tmpFolder
            )
          }
        }

        installKeys = Object.keys(newInstalls)
        if (installKeys.length) {
          this._print('Installing new packages...')
          while ((pName = installKeys.pop())) {
            yield this._install(pName, tmpFolder)
            yield this._migrate(pName, config.migDir)
          }
        }

        let uninstallKeys = Object.keys(packagesToRemove)
        if (uninstallKeys.length) {
          this._print('Removing useless packages...')
          while ((pName = uninstallKeys.pop())) {
            yield this._uninstall(pName)
            yield this._migrate(pName, config.migDir, true)
          }
        }

        yield this._saveManifest(config, localManifest, manifest, 'npm')

        const endData = {
          level: 'success',
          message: 'Your XOA has been successfully updated.',
          state: 'xoa-upgraded'
        }
        this._end(endData)

        try {
          yield this._handleRestarts(Object.keys(newInstalls))
        } catch (err) {
          this._print(logSymbols.warning + ' ' + err.message)
        }

        return endData
      } finally {
        fse.removeAsync(tmpFolder)
      }
    })

    this._getMigrations = Bluebird.coroutine(function * (localManifest, remoteManifest, config, token) {
      const newPackages = this._findNewPackages(localManifest.migrations, remoteManifest.migrations)
      const newVersions = this._findNewPckgVersions(localManifest.migrations, remoteManifest.migrations)
      const packagesToRemove = this._findSuppressedPackages(localManifest.migrations, remoteManifest.migrations)

      if (Object.keys(newPackages).length) {
        this._print('New migration sets available:')
        for (let key in newPackages) {
          this._print('  ' + chalk.blue(key + ' ' + newPackages[key]))
        }
      }

      if (Object.keys(newVersions).length) {
        this._print('New migrations set versions available:')
        for (let key in newVersions) {
          this._print('  ' + key + ' ' + chalk.blue(newVersions[key]))
        }
      }

      if (Object.keys(packagesToRemove).length) {
        this._print('Following migration sets will be removed:')
        for (let key in packagesToRemove) {
          this._print('  ' + chalk.yellow(key + ' ' + packagesToRemove[key]))
        }
      }

      console.log()
      const tmpFolder = this._generateTmpFolder(config.pckgDir)
      yield fse.ensureDirAsync(tmpFolder)
      try {
        const newInstalls = _assign({}, newPackages, newVersions)
        let pName

        let installKeys = Object.keys(newInstalls)
        if (installKeys.length) {
          this._print('Downloading migration sets...')
          while ((pName = installKeys.pop())) {
            yield this._getPackage(
              config.updateUrl + '/downloads',
              token,
              pName,
              newInstalls[pName],
              tmpFolder
            )
          }
        }

        installKeys = Object.keys(newInstalls)
        if (installKeys.length) {
          this._print('Installing new migrations sets...')
          while ((pName = installKeys.pop())) {
            yield this._install(pName, tmpFolder)
            yield this._migrate(pName, config.migDir)
          }
        }

        let uninstallKeys = Object.keys(packagesToRemove)
        if (uninstallKeys.length) {
          this._print('Removing useless migration sets...')
          while ((pName = uninstallKeys.pop())) {
            yield this._uninstall(pName)
            yield this._migrate(pName, config.migDir, true)
          }
        }

        yield this._saveManifest(config, localManifest, remoteManifest, 'migrations')
        return
      } finally {
        fse.removeAsync(tmpFolder)
      }
    })
  }

  _getConfig (override = undefined) {
    if (!this._config || override) {
      return loadConfig(appName)
      .then(config => {
        _assign(config, override)
        this._config = config
        return this._config
      })
    } else {
      return Bluebird.resolve(this._config)
    }
  }

  configure (config) {
    return this.getConfiguration()
    .then(_config => {
      _assign(_config, config)
      for (let key in _config) {
        if (_config[key] === null) {
          delete _config[key]
        }
      }
      return fse.outputJsonAsync('/etc/' + appName + '/config.updater.z.json', _config)
      .return(_config)
      .then(_config => {
        _assign(this._config, config)
        for (let key in this._config) {
          if (this._config[key] === null) {
            delete _config[key]
          }
        }
      })
      .return(_config)
    })
  }

  getConfiguration () {
    return fse.readJsonAsync('/etc/' + appName + '/config.updater.z.json')
    .catch(err => err.code === 'ENOENT', () => ({}))
  }

  _getProxy () {
    return this._getConfig()
    .then(config => {
      let proxy
      let auth = ''
      if (config.proxyUser && config.proxyUser !== '') {
        auth += config.proxyUser + ':' + (config.proxyPassword || '') + '@'
      }
      if (config.proxyHost) {
        proxy = 'http://' + auth + config.proxyHost
        if (config.proxyPort) {
          proxy += ':' + config.proxyPort
        }
      }
      return proxy
    })
  }

  _post (url, method, params, id) {
    const reqParams = {
      url,
      rejectUnauthorized: false, // TODO Find something better
      json: true,
      body: format.request(method, params, id)
    }
    return this._getProxy()
    .then(proxy => {
      proxy && (reqParams.proxy = proxy)
      return request.postAsync(reqParams)
      .catch(err => err.code === 'ECONNREFUSED', () => {
        throw new ServerNotReached('Xen Orchestra Server could not be reached')
      })
      .catch(err => err.code === 'ENOTFOUND', () => {
        throw new HostNotFound((proxy ? 'Your xoa-updater proxy may be misconfigured or ' : '') + 'xoa-updater may be misconfigured for reaching Xen Orchestra servers')
      })
      .then(([response, body]) => {
        switch (response.statusCode) {
          case 401:
            throw new AuthenticationFailed('Authentication failed')
          case 405:
            throw new RequestNotAllowed('Request not allowed')
          case 407:
            throw new ProxyAuthFailed('Proxy authentication needed or failed')
          case 500:
            // console.log(body)
            throw new Error('Internal error from Xen Orchestra Server')
        }
        if (body.error) {
          const errorMap = {
            3: TrialAlreadyConsumed,
            4: AlreadyUnderTrial,
            5: TrialUnavailabe,
            6: ResourceNotFound,
            7: NotRegistered
          }
          if (body.error.code in errorMap) {
            throw new errorMap[body.error.code](body.error.message)
          } else {
            throw new Error('Unknown Error from Xen Orchestra Server')
          }
        }
        if (response.statusCode !== 200) {
          throw new Error('Unexpected Error from Xen Orchestra Server')
        }
        return [response, body]
      })

    })
  }

  _print (...content) {
    console.log(...content)
    this.emit('print', content)
    return content
  }

  _end (data) {
    console.log(data.message)
    this.emit('end', data)
    return data
  }

  _saveManifest (config, localManifest, manifest, section) {
    if (!section || !manifest[section]) {
      throw new Error('Unhandled manifest section : ' + section + ' not in [npm, updater]')
    }
    return fse.readJsonAsync(config.updateFile)
    .catch(err => err.code === 'ENOENT', () => {return {}})
    .then(content => {
      localManifest[section] = manifest[section]
      localManifest[section + 'Source'] = manifest.name
      if (section === 'npm') {
        localManifest.trial = manifest.trial
      }
      content.manifest = localManifest
      return fse.outputJsonAsync(config.updateFile, content)
      .return(localManifest)
    })
  }

  jsonrpc_update ({upgrade, url, forceToken} = {}) {
    return this.update(upgrade, url, forceToken)
  }

  _getRegistrationToken () {
    return this._getConfig()
    .then(config => {
      return fse.readJsonAsync(config.registerFile)
      .catch(() => {return {}})
    })
  }

  isRegistered () {
    return this._getRegistrationToken()
    .then(token => {
      if (token.registrationToken !== undefined) {
        return token
      } else {
        return {}
      }
    })
  }

  register (email, password, renew = false) {
    return this.isRegistered()
    .then(token => {
      if (token.registrationToken !== undefined && !renew) {
        throw new AlreadyRegistered('Your appliance is already registered')
      } else {
        return this._getConfig()
      }
    })
    .then(config => {
      return this._post(config.registerUrl, 'registerXoa', {email, password}, 'xoa-register')
      .then(([response, body]) => {
        const token = {registrationToken: body.result, registrationEmail: email}
        return fse.outputJsonAsync(config.registerFile, token)
        .return(token)
      })
    })
  }

  jsonrpc_register ({email, password, renew}) {
    return this.register(email, password, renew)
  }

  _getLocalManifest (config) {
    return fse.readJsonAsync(config.updateFile)
    .then(content => content.manifest)
    .catch(() => ({npm: {}, migrations: {}}))
  }

  _findNewPackages (local, remote) {
    return _pick(remote, (value, key) => !_has(local, key))
  }

  _findNewPckgVersions (local, remote) {
    return _pick(remote, (value, key) => local[key] && semver.gt(value, local[key]))
  }

  _findSuppressedPackages (local, remote) {
    return _pick(local, (value, key) => !_has(remote, key))
  }

  _getManifest (url, token) {
    /*return Bluebird.resolve({
    	npm: {}
    })*/
    return this._post(url, 'getManifest', {token}, 'xoa-updater')
    .then(([response, body]) => body.result)
  }

  _install (pckg, path) {
    return (Bluebird.resolve(pckg === 'npm' ? true : this._uninstall(pckg)))
    .then(() => {
      let display = '  ' + pckg
      process.stdout.write(display + '\r')
      return this._getProxy()
      .then(proxy => {
        const proxyOpt = proxy ? ('--proxy ' + proxy + ' ') : ''
        return execAsync('npm i -g --silent ' + proxyOpt + path + '/' + pckg)
        .then(() => this._print(display + ' ' + logSymbols.success))
      })
      .catch(error => {
        console.log(display, logSymbols.error)
        throw error
      })
    })
  }

  _uninstall (pckg) {
    let display = '  ' + chalk.gray(pckg)
    process.stdout.write(display + '\r')
    return this._getProxy()
    .then(proxy => {
      const proxyOpt = proxy ? ('--proxy ' + proxy + ' ') : ''
      return execAsync('npm remove -g --silent ' + proxyOpt + pckg)
      .then(() => this._print(display + ' ' + logSymbols.success))
    })
    .catch(error => {
      console.log(display, logSymbols.error)
      throw error
    })
  }

  _getPackage (url, token, pckg, version, dest) {
    return this._getProxy()
    .then(proxy => new Bluebird((resolve, reject) => {
      let isOnError = false
      let errorData = ''
      let display = '  ' + pckg + ' '
      let shasum

      let reqParams = {
        url: [url, token, pckg, version].join('/'),
        rejectUnauthorized: false  // TODO Find something better
      }
      proxy && (reqParams.proxy = proxy)

      request
      .get(reqParams)
      .on('response', response => {
        if (response.statusCode === 200) {
          process.stdout.write(display + '\r')
          shasum = response.headers.shasum
        } else {
          isOnError = true
        }
      })
      .on('data', data => {
        if (isOnError) {
          errorData += String(data)
        } else {
          display += '.'
          process.stdout.write(display + '\r')
        }
      })
      .on('error', error => reject(error))
      .pipe(fse.createWriteStream(dest + '/' + pckg)
      .on('finish', () => {
        if (!isOnError) {
          return hashFilesAsync({
            files: [dest + '/' + pckg],
            algorithm: 'sha1',
            noGlob: true
          })
          .then(hash => {
            if (hash !== shasum) {
              this._print(display + ' ' + logSymbols.error)
              fse.unlinkAsync(dest + '/' + pckg).catch(() => {})
              reject(new Error('Checksum failure'))
            } else {
              display += ' ok'
              this._print(display + ' ' + logSymbols.success)
              resolve({name: pckg, version})
            }
          })
        } else {
          this._print(display + ' ' + logSymbols.error)
          fse.unlinkAsync(dest + '/' + pckg).catch(() => {})
          reject(new Error(errorData))
        }
      }))
    }))
  }

  _getNamespaceNames (localManifest, remoteManifest, namespace) {
    return {
      remoteName: remoteManifest[namespace] && Object.keys(remoteManifest[namespace]).pop(),
      localName: localManifest[namespace] && Object.keys(localManifest[namespace]).pop()
    }
  }

  _checkNamespace (localManifest, remoteManifest, namespace) {
    if (remoteManifest[namespace]) {
      const {remoteName, localName} = this._getNamespaceNames(localManifest, remoteManifest, namespace)
      if (
        !localName || // Previous installation not handled by xoa-updater
        remoteName !== localName || // Package name changed
        semver.gt(remoteManifest[namespace][remoteName], localManifest[namespace][localName]) // Package version increments
      ) {
        this._print('New ' + namespace + ' available! ' + chalk.blue('(' + remoteManifest[namespace][remoteName] + ')'))
        return namespace
      }
    }
    return false
  }

  _upgradeNamespace (localManifest, remoteManifest, config, token, namespace) {
    const {remoteName, localName} = this._getNamespaceNames(localManifest, remoteManifest, namespace)
    const tmpFolder = this._generateTmpFolder(config.pckgDir)
    return fse.ensureDirAsync(tmpFolder)
    .then(() => {
      this._print('Downloading...')
      return this._getPackage(
        config.updateUrl + '/downloads',
        token,
        remoteName,
        remoteManifest[namespace][remoteName],
        tmpFolder
      )
    })
    .then(() => {
      if (namespace === 'updater') {
        const thisDir = this._baseDir(module.filename)
        let bkDir = thisDir + '-' + Date.now()
        let display = 'Saving current version in ' + bkDir + '...'
        process.stdout.write(display + '\r')
        return fse.copyAsync(thisDir, bkDir)
        .catch(error => {
          this._print(display + ' ' + logSymbols.error)
          throw error
        })
        .then(() => this._print(display + 'ok ' + logSymbols.success))
      }
    })
    .then(() => {
      this._print('Installing...')
      return this._install(remoteName, tmpFolder)
      .then(() => this._migrate(remoteName, config.migDir))
    })
    .then(() => {
      if (localName && remoteName !== localName) {
        let display = 'Uninstalling former ' + namespace + '...'
        process.stdout.write(display + '\r')
        return this._uninstall(localName)
        .then(() => this._migrate(localName, config.migDir, true))
        .catch(error => {
          this._print(display + ' ' + logSymbols.error)
          throw error
        })
        .then(() => this._print(display + ' ' + logSymbols.success))
        .return(true)
      } else {
        return true
      }
    })
    .finally(() => {
      fse.removeAsync(tmpFolder)
      .catch(() => {})
    })
  }

  _baseDir (filePath) {
    const dirs = filePath.split('/')
    dirs.pop()
    return dirs.join('/')
  }

  _migrate (packageName, migDir, down = false) {
    if (!migDir) {
      return Bluebird.resolve()
    }
    const migrationsPath = migDir + '/migrations/' + packageName
    return fse.statAsync(migrationsPath)
    .catch(error => error.code === 'ENOENT', () => false)
    .then(stats => {
      if (!stats) {
        return
      } else {
        if (!stats.isDirectory()) {
          throw new Error('Unexpected migration files structure for ' + packageName)
        }
        const direction = down ? 'downAsync' : 'upAsync'
        const migrationSet = migrate.load(migrationsPath + '/.migrate', migrationsPath + '/migrations')
        Bluebird.promisifyAll(migrationSet)
        this._print('Running migration scripts for: ' + packageName)
        return migrationSet[direction]()
        .then(() => this._print('Migration successful for: ' + packageName))
        .catch(error => {
          throw new Error('Migrations failed for ' + packageName + ': ' + error.message)
        })
      }
    })
  }

  _generateTmpFolder (base) {
    return base + '/' + Date.now()
  }

  _handleRestarts (packages) {
    let xoServer = false
    packages.forEach(name => {
      xoServer = xoServer || (name.search(/^xo-server/) !== -1)
    })
    const promises = []
    xoServer && promises.push(this._restartService('xo-server'))
    return Bluebird.all(promises)
  }

  _restartService (service) {
    return execAsync('systemctl is-active ' + service + '.service')
    .catch(() => ({noStart: true}))
    .then(output => {
      if (output.noStart) {
        return true
      } else {
        this._print(service + ' will be restarted...')
        return execAsync('systemctl restart ' + service + '.service')
        .then(() => this._print('Restarting ' + service + ' ' + logSymbols.success))
        .catch(error => {
          throw new Error(service + ' could not be restarted: ' + error && error.message || 'unknown error')
        })
      }
    })
  }

  jsonrpc_requestTrial ({trialPlan}) {
    return this.requestTrial(trialPlan)
  }

  requestTrial (trialPlan) {
    return this._getRegistrationToken()
    .then(token => {
      if (token.registrationToken === undefined) {
        return {
          level: 'warning',
          message: 'Your appliance is not registered, take time to register first.',
          state: 'register-needed'
        }
      } else {
        return this._getConfig()
        .then(config => {
          return this._post(config.updateUrl, 'requestTrial', {token: token.registrationToken, trialPlan}, 'xoa-updater')
          .then(([response, body]) => body.result)
        })
      }
    })
  }

  xoaState () {
    let _config
    let underTrial
    let _token
    return this._getConfig()
    .tap(config => _config = config)
    .then(config => fse.readJsonAsync(config.updateFile))
    .catch(() => false)
    .tap(updateFile => underTrial = updateFile && updateFile.manifest && updateFile.manifest.trial)
    .then(() => this._getRegistrationToken())
    .tap(token => _token = token && token.registrationToken || null)
    .then(() => {
      if (!_token) {
        return underTrial ?
        {
            state: 'untrustedTrial',
            message: 'You have a Xen Orchestra Appliance granted under trial. Your appliance must be registered and able to reach https://xen-orchestra.com for use.'
        } :
        {state: 'default'}
      } else {
        return this._post(_config.updateUrl, 'checkTrial', {token: _token}, 'xoa-updater')
        .then(([response, body]) => {
          const trial = body.result || {}
          if (underTrial && (!trial || !trial.end || Date.now() >= trial.end)) {
            return {
              state: 'untrustedTrial',
              message: 'You have a Xen Orchestra Appliance granted under trial and your trial has ended. You must run the updater to get back to your usual XOA version.',
              trial
            }
          } else if (underTrial) {
            return {
              state: 'trustedTrial',
              message: 'You have a Xen Orchestra Appliance granted under trial. Your trial lasts until ' + new Date(trial.end).toLocaleString(),
              trial
            }
          } else {
            return {
              state: 'default',
              trial: (trial.end ? trial : null)
            }
          }
        })
        .catch(err => {
          return underTrial ?
          {
            state: 'untrustedTrial',
            message: 'You have a Xen Orchestra Appliance granted under trial. Your appliance appears to fail reaching https://xen-orchestra.com for the following reason: ' + err.message,
            error: err.message
          } :
          {state: 'default'}
        })
      }
    })
  }
}

export const xoaUpdater = new XoaUpdater()
export const findNewPackages = xoaUpdater._findNewPackages
export const findNewPckgVersions = xoaUpdater._findNewPckgVersions
export const findSuppressedPackages = xoaUpdater._findSuppressedPackages
