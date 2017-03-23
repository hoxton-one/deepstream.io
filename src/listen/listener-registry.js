'use strict'

const C = require('../constants/constants')
const SubscriptionRegistry = require('../utils/subscription-registry')
const messageBuilder = require('../message/message-builder')

const SEP = String.fromCharCode(30)

module.exports = class ListenerRegistry {
  constructor (topic, options, subscriptionRegistry) {
    this._reconcile = this._reconcile.bind(this)
    this._dispatch = this._dispatch.bind(this)
    this._onError = this._onError.bind(this)

    this._pending = new Set()
    this._listeners = new Map()
    this._timeouts = new Map()

    this._topic = topic
    this._listenResponseTimeout = options.listenResponseTimeout
    this._serverName = options.serverName
    this._subscriptionRegistry = subscriptionRegistry
    this._logger = options.logger

    const clusterTopic = `${topic}_${C.TOPIC.LISTEN_PATTERNS}`

    this._providers = options.stateConnector.get(clusterTopic)
    this._providers.watch(this._reconcile)
    this._providerRegistry = new SubscriptionRegistry(options, topic, clusterTopic)
    this._providerRegistry.setAction('subscribe', C.ACTIONS.LISTEN)
    this._providerRegistry.setAction('unsubscribe', C.ACTIONS.UNLISTEN)
    this._providerRegistry.setSubscriptionListener({
      onSubscriptionRemoved: this.onListenRemoved.bind(this),
      onSubscriptionMade: this.onListenMade.bind(this)
    })
  }

  handle (socket, message) {
    if (message.action === C.ACTIONS.LISTEN) {
      this._providerRegistry.subscribe(message.data[0], socket)
    } else if (message.action === C.ACTIONS.UNLISTEN) {
      this._providerRegistry.unsubscribe(message.data[0], socket)
    } else if (message.action === C.ACTIONS.LISTEN_ACCEPT) {
      this._accept(socket, message.data)
    } else if (message.action === C.ACTIONS.LISTEN_REJECT) {
      this._reject(socket, message.data)
    } else {
      socket.sendError(this._topic, C.EVENT.INVALID_MESSAGE_DATA, message.raw)
    }
  }

  onListenMade (pattern, socket, localCount) {
    if (!socket) {
      return
    }

    const listener = this._listeners.get(socket.uuid) || { socket, patterns: new Set() }

    if (listener.patterns.size === 0) {
      this._listeners.set(socket.uuid, listener)
    }

    try {
      RegExp(pattern)
    } catch (err) {
      socket.sendError(this._topic, C.EVENT.INVALID_MESSAGE_DATA, err.message)
      return
    }

    listener.patterns.add(pattern)

    this._reconcilePattern(pattern)
  }

  onListenRemoved (pattern, socket, localCount) {
    if (!socket) {
      return
    }

    const listener = this._listeners.get(socket.uuid)

    listener.patterns.delete(pattern)

    if (listener.patterns.size === 0) {
      this._listeners.delete(socket.uuid)
    }

    this._reconcilePattern(pattern)
  }

  onSubscriptionMade (name, socket, localCount) {
    if (socket) {
      if (localCount > 1) {
        this._providers
          .get(name)
          .then(provider => {
            if (!provider.deadline && this._isAlive(provider)) {
              this._sendHasProviderUpdate(true, name, socket)
            }
          })
          .catch(this._onError)
      } else {
        this._reconcile(name)
      }
    } else {
      this._reconcile(name)
    }
  }

  onSubscriptionRemoved (name, socket, localCount, remoteCount) {
    if (localCount + remoteCount === 0) {
      this._reconcile(name)
    }
  }

  _accept (socket, [ pattern, name ]) {
    clearTimeout(this._timeouts.get(name))
    this._timeouts.delete(name)

    this._providers
      .upsert(name, prev => prev.deadline
        ? {
          uuid: socket.uuid,
          pattern: pattern,
          serverName: this._serverName,
          deadline: null
        } : null
      )
      .then(([ next, prev ]) => {
        if (!next) {
          socket.sendMessage(this._topic, C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_REMOVED, [ pattern, name ])
        } else {
          this._sendHasProviderUpdate(true, name)
        }
      })
      .catch(this._onError)
  }

  _reject (socket, [ pattern, name ]) {
    clearTimeout(this._timeouts.get(name))
    this._timeouts.delete(name)

    this._providers
      .upsert(name, prev => prev.uuid === socket.uuid && prev.pattern === pattern
        ? { history: prev.history } : null
      )
      .then(([ next, prev ]) => {
        if (!next) {
          this._reconcile(name)
        }
      })
      .catch(this._onError)
  }

  _onError (err) {
    this._errorTimeout = setTimeout(() => {
      this._errorTimeout = null
      for (const name of this._subscriptionRegistry.getNames()) {
        this._reconcile(name)
      }
    }, 10000)
    this._logger.log(C.LOG_LEVEL.ERROR, err.message)
  }

  _reconcilePattern (pattern) {
    for (const name of this._subscriptionRegistry.getNames()) {
      if (name.match(pattern)) {
        this._reconcile(name)
      }
    }
  }

  _reconcile (name) {
    this._pending.add(name)
    this._dispatching = this._dispatching || setTimeout(this._dispatch, 10)
  }

  _dispatch () {
    if (this._pending.size === 0) {
      this._dispatching = null
      return
    }

    const promises = []
    for (const name of this._pending) {
      let promise
      if (this._subscriptionRegistry.hasName(name)) {
        promise = this._tryAdd(name)
      } else {
        promise = this._tryRemove(name)
      }
      promises.push(promise.catch(this._onError))
    }

    this._pending.clear()

    Promise.all(promises).then(this._dispatch)
  }

  _match (name) {
    const matches = []
    for (const { socket, patterns } of this._listeners.values()) {
      for (const pattern of patterns) {
        if (name.match(pattern)) {
          matches.push({ id: socket.uuid + SEP + pattern, socket, pattern })
        }
      }
    }
    return matches
  }

  _tryAdd (name) {
    return this._providers
      .upsert(name, prev => {
        if (this._isAlive(prev)) {
          return
        }

        const history = prev.history || []
        const matches = this._match(name).filter(match => !history.includes(match.id))

        if (matches.length === 0) {
          return { history }
        }

        const match = matches[Math.floor(Math.random() * matches.length)]

        return {
          history: history.concat(match.id),
          uuid: match.socket.uuid,
          pattern: match.pattern,
          serverName: this._serverName,
          deadline: Date.now() + this._listenResponseTimeout
        }
      })
      .then(([ next, prev ]) => {
        if (!next) {
          return
        }

        if (prev.uuid) {
          this._sendHasProviderUpdate(false, name)
        }
      
        if (!next.uuid) {
          return
        }

        const listener = this._listeners.get(next.uuid)

        if (listener) {
          listener.socket.sendMessage(
            this._topic,
            C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_FOUND,
            [ next.pattern, name ]
          )

          this._timeouts.set(name, setTimeout(() => this._reconcile(name), this._listenResponseTimeout))
        } else {
          this._reconcile(name)
        }
      })
  }

  _tryRemove (name) {
    return this._providers
      .upsert(name, prev => prev.uuid && (this._isLocal(prev) || !this._isRemote(prev))
        ? {}
        : null
      )
      .then(([ next, prev ]) => {
        if (!next) {
          return
        }

        const listener = this._listeners.get(prev.uuid)

        if (listener) {
          listener.socket.sendMessage(
            this._topic,
            C.ACTIONS.SUBSCRIPTION_FOR_PATTERN_REMOVED,
            [ prev.pattern, name ]
          )
        }
      })
  }

  _isLocal (provider) {
    return (
      provider &&
      provider.serverName === this._serverName
    )
  }

  _isRemote (provider) {
    return (
      provider &&
      this._subscriptionRegistry.getAllRemoteServers().indexOf(provider.serverName) !== -1
    )
  }

  _isConnected (provider) {
    if (!provider) {
      return false
    } else if (this._isLocal(provider)) {
      const listener = this._listeners.get(provider.uuid)
      return listener && listener.patterns.has(provider.pattern)
    } else {
      return this._isRemote(provider)
    }
  }

  _isAlive (provider) {
    return (
      provider &&
      (!provider.deadline || provider.deadline > Date.now()) &&
      this._isConnected(provider)
    )
  }

  _sendHasProviderUpdate (hasProvider, name, socket) {
    if (this._topic !== C.TOPIC.RECORD) {
      return
    }

    const message = messageBuilder.getMsg(
      C.TOPIC.RECORD,
      C.ACTIONS.SUBSCRIPTION_HAS_PROVIDER,
      [ name, hasProvider ? C.TYPES.TRUE : C.TYPES.FALSE ]
    )

    if (socket) {
      socket.send(message)
    } else {
      this._subscriptionRegistry.sendToSubscribers(name, message)
    }
  }
}
