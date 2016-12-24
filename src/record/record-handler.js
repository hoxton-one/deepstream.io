const C = require('../constants/constants')
const SubscriptionRegistry = require('../utils/subscription-registry')
const ListenerRegistry = require('../listen/listener-registry')
const messageBuilder = require('../message/message-builder')
const utils = require('../utils/utils')
const LRU = require('lru-cache')

const REV_EXPR = /\d+-.+/

const RecordHandler = function (options) {
  this._subscriptionRegistry = new SubscriptionRegistry(options, C.TOPIC.RECORD)
  this._listenerRegistry = new ListenerRegistry(C.TOPIC.RECORD, options, this._subscriptionRegistry)
  this._subscriptionRegistry.setSubscriptionListener(this._listenerRegistry)
  this._permissionHandler = options.permissionHandler
  this._logger = options.logger
  this._message = options.messageConnector || options.message
  this._storage = options.storageConnector || options.storage
  this._storage.on('change', this._onStorageChange.bind(this))
  this._recordCache = new LRU({
    max: (options.cacheSize || 1e4)
  })
}

RecordHandler.prototype.handle = function (socketWrapper, message) {
  if (!message.data || message.data.length < 1) {
    this._sendError(C.EVENT.INVALID_MESSAGE_DATA, [undefined, message.raw], socketWrapper)
    return
  }

  if (message.action === C.ACTIONS.READ) {
    this._read(socketWrapper, message)
    return
  }

  if (message.action === C.ACTIONS.UPDATE) {
    this._update(socketWrapper, message)
    return
  }

  if (message.action === C.ACTIONS.UNSUBSCRIBE) {
    this._unsubscribe(socketWrapper, message)
    return
  }

  if (message.action === C.ACTIONS.LISTEN ||
    message.action === C.ACTIONS.UNLISTEN ||
    message.action === C.ACTIONS.LISTEN_ACCEPT ||
    message.action === C.ACTIONS.LISTEN_REJECT) {
    this._listenerRegistry.handle(socketWrapper, message)
    return
  }

  const recordName = message.data[0]

  this._logger.log(C.LOG_LEVEL.WARN, C.EVENT.UNKNOWN_ACTION, [ recordName, message.action ])

  this._sendError(C.EVENT.UNKNOWN_ACTION, [ recordName, 'unknown action ' + message.action ], socketWrapper)
}

RecordHandler.prototype.getRecord = function (recordName, callback) {
  const record = this._recordCache.get(recordName)
  return record ? Promise.resolve(record) : new Promise((resolve, reject) => this._storage.get(recordName, (error, recordName, record) => {
    if (error) {
      reject(error)
    } else {
      resolve(this._updateCache(recordName, record))
    }
  }))
}

RecordHandler.prototype._read = function (socketWrapper, message) {
  const recordName = message.data[0]

  const record = this._recordCache.get(recordName)

  if (record) {
    this._sendRead(recordName, record, socketWrapper)
  } else {
    this._storage.get(recordName, (error, recordName, record, socketWrapper) => {
      if (error) {
        const message = 'error while reading ' + recordName + ' from storage'
        this._sendError(C.EVENT.RECORD_LOAD_ERROR, [ recordName, message ], socketWrapper)
      } else {
        this._sendRead(recordName, this._updateCache(recordName, record), socketWrapper)
      }
    }, socketWrapper)
  }
}

RecordHandler.prototype._sendRead = function (recordName, record, socketWrapper) {
  this._subscriptionRegistry.subscribe(recordName, socketWrapper)
  socketWrapper.sendMessage(C.TOPIC.RECORD, C.ACTIONS.READ, [ recordName, record._v, utils.stringifyImmutable(record._d), record._p ])
}

RecordHandler.prototype._update = function (socketWrapper, message) {
  const recordName = message.data[0]

  if (message.data.length < 3) {
    this._sendError(C.EVENT.INVALID_MESSAGE_DATA, [ recordName, message.data[0] ], socketWrapper)
    return
  }

  const version = message.data[1]

  if (!version || !version.match(REV_EXPR)) {
    this._sendError(C.EVENT.INVALID_VERSION, [ recordName, version ], socketWrapper)
    return
  }

  const parent = message.data[3]

  if (parent && !parent.match(REV_EXPR)) {
    this._sendError(C.EVENT.INVALID_VERSION, [ recordName, parent ], socketWrapper)
    return
  }

  const data = utils.JSONParse(message.data[2])

  if (data.error) {
    this._sendError(C.EVENT.INVALID_MESSAGE_DATA, [ recordName, message.raw ], socketWrapper)
    return
  }

  const record = {
    _v: version,
    _d: data.value,
    _p: parent
  }

  utils.stringifyImmutable(record._d, message.data[2])

  if (socketWrapper !== C.SOURCE_MESSAGE_CONNECTOR) {
    this._storage.set(recordName, record, error => {
      if (error) {
        const message = 'error while writing ' + recordName + ' to storage.'
        this._sendError(C.EVENT.RECORD_UPDATE_ERROR, [ recordName, message ], !record && socketWrapper)
      }
    }, socketWrapper)
    this._message.publish(C.TOPIC.RECORD, message)
  }

  if (this._updateCache(recordName, record) === record) {
    this._subscriptionRegistry.sendToSubscribers(recordName, message.raw, socketWrapper)
  }
}

RecordHandler.prototype._unsubscribe = function (socketWrapper, message) {
  const recordName = message.data[0]

  this._subscriptionRegistry.unsubscribe(recordName, socketWrapper)
}

RecordHandler.prototype._sendError = function (event, message, socketWrapper) {
  if (socketWrapper && socketWrapper.sendError) {
    socketWrapper.sendError(C.TOPIC.RECORD, event, message)
  } else {
    this._logger.log(C.LOG_LEVEL.ERROR, event, message)
  }
}

RecordHandler.prototype._onStorageChange = function (recordName, version) {
  if (this._subscriptionRegistry.getLocalSubscribersCount(recordName) === 0) {
    this._recordCache.delete(recordName)
    return
  }

  const prevRecord = this._recordCache.peek(recordName)

  if (prevRecord && utils.compareVersions(prevRecord._v, version)) {
    return
  }

  this._storage.get(recordName, (error, recordName, nextRecord) => {
    if (error) {
      this._logger.log(C.LOG_LEVEL.ERROR, error.event, [ recordName, error.message ])
    } else if (this._updateCache(recordName, nextRecord) === nextRecord) {
      this._subscriptionRegistry.sendToSubscribers(
        recordName,
        messageBuilder.getMsg(C.TOPIC.RECORD, C.ACTIONS.UPDATE, [ recordName, nextRecord._v, utils.stringifyImmutable(nextRecord._d), nextRecord._p ]),
        C.SOURCE_STORAGE_CONNECTOR
      )
    }
  })
}

RecordHandler.prototype._updateCache = function (recordName, nextRecord) {
  const prevRecord = this._recordCache.peek(recordName)

  if (prevRecord && utils.compareVersions(prevRecord._v, nextRecord._v)) {
    return prevRecord
  }

  this._recordCache.set(recordName, nextRecord)

  return nextRecord
}

module.exports = RecordHandler
