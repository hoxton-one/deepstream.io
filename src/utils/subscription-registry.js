const C = require('../constants/constants')
const SocketWrapper = require('../message/socket-wrapper')

class SubscriptionRegistry {
  constructor (options, topic) {
    this._names = new Map()
    this._pending = new Set()
    this._subscriptions = new Map()
    this._options = options
    this._topic = topic
    this._subscriptionListener = null
    this._constants = {
      MULTIPLE_SUBSCRIPTIONS: C.EVENT.MULTIPLE_SUBSCRIPTIONS,
      SUBSCRIBE: C.ACTIONS.SUBSCRIBE,
      UNSUBSCRIBE: C.ACTIONS.UNSUBSCRIBE,
      NOT_SUBSCRIBED: C.EVENT.NOT_SUBSCRIBED
    }
    this._onBroadcastTimeout = this._onBroadcastTimeout.bind(this)
    this._onSocketClose = this._onSocketClose.bind(this)

    setInterval(this._onBroadcastTimeout, options.broadcastTimeout || 0)
  }

  getNames () {
    return this._subscriptions.keys()
  }

  hasName (subscriptionName) {
    return this._subscriptions.has(subscriptionName)
  }

  getSubscribers (name) {
    const subscription = this._subscriptions.get(name)
    return subscription ? subscription.sockets : new Set()
  }

  setAction (name, value) {
    this._constants[name.toUpperCase()] = value
  }

  setSubscriptionListener (subscriptionListener) {
    this._subscriptionListener = subscriptionListener
  }

  subscribe (name, socket) {
    const subscription = this._subscriptions.get(name) || {
      sharedMessages: '',
      uniqueSenders: new Map(),
      sockets: new Set()
    }

    if (subscription.sockets.size === 0) {
      this._subscriptions.set(name, subscription)
    } else if (subscription.sockets.has(socket)) {
      this._options.logger.log(
        C.LOG_LEVEL.WARN,
        this._constants.MULTIPLE_SUBSCRIPTIONS,
        `repeat supscription to "${name}" by ${socket.user}`
      )
      socket.sendError(this._topic, this._constants.MULTIPLE_SUBSCRIPTIONS, name)
      return
    }

    subscription.sockets.add(socket)

    if (!socket.listeners('close').includes(this._onSocketClose)) {
      socket.once('close', this._onSocketClose)
    }

    const names = this._names.get(socket) || new Set()
    if (names.size === 0) {
      this._names.set(socket, names)
    }
    names.add(name)

    if (this._subscriptionListener) {
      this._subscriptionListener.onSubscriptionAdded(
        name,
        socket,
        subscription.sockets.size
      )
    }

    this._options.logger.log(
      C.LOG_LEVEL.DEBUG,
      this._constants.SUBSCRIBE,
      `for ${this._topic}:${name} by ${socket.user}`
    )
  }

  unsubscribe (name, socket, silent) {
    const subscription = this._subscriptions.get(name)

    if (!subscription || !subscription.sockets.delete(socket)) {
      this._options.logger.log(
        C.LOG_LEVEL.WARN,
        this._constants.NOT_SUBSCRIBED,
        `${socket.user} is not subscribed to ${name}`
      )
      socket.sendError(this._topic, this._constants.NOT_SUBSCRIBED, name)
      return
    }

    if (subscription.sockets.size === 0) {
      this._subscriptions.delete(name)
      this._pending.delete(subscription)
    } else {
      subscription.uniqueSenders.delete(socket)
    }

    const names = this._names.get(socket)
    names.delete(name)

    if (names.size === 0) {
      this._names.delete(socket)
      socket.removeListener('close', this._onSocketClose)
    }

    if (this._subscriptionListener) {
      this._subscriptionListener.onSubscriptionRemoved(
        name,
        socket,
        subscription.sockets.size
      )
    }

    if (!silent) {
      this._options.logger.log(
        C.LOG_LEVEL.DEBUG,
        this._constants.UNSUBSCRIBE,
        `for ${this._topic}:${name} by ${socket.user}`
      )
    }
  }

  sendToSubscribers (name, msg, socket) {
    if (!msg) {
      return
    }

    const subscription = this._subscriptions.get(name)

    if (!subscription) {
      return
    }

    // not all messages are valid, this should be fixed elsewhere!
    if (msg.charAt(msg.length - 1) !== C.MESSAGE_SEPERATOR) {
      msg += C.MESSAGE_SEPERATOR
    }

    // append this message to the sharedMessage, the message that
    // is shared in the broadcast to every listener-only
    const start = subscription.sharedMessages.length
    subscription.sharedMessages += msg
    const stop = subscription.sharedMessages.length

    this._pending.add(subscription)

    if (!socket) {
      return
    }

    const gaps = subscription.uniqueSenders.get(socket) || []

    if (gaps.length === 0) {
      subscription.uniqueSenders.set(socket, gaps)
    }

    gaps.push(start, stop)
  }

  _onSocketClose (socket) {
    for (const name of this._names.get(socket)) {
      this.unsubscribe(name, socket, true)
    }
  }

  _onBroadcastTimeout () {
    for (const subscription of this._pending) {
      const { uniqueSenders, sharedMessages, sockets } = subscription

      for (const [ socket, gaps ] of uniqueSenders) {
        let i = 0
        let message = sharedMessages.substring(0, gaps[i++])
        let lastStop = gaps[i++]

        while (i < gaps.length) {
          message += sharedMessages.substring(lastStop, gaps[i++])
          lastStop = gaps[i++]
        }
        message += sharedMessages.substring(lastStop, sharedMessages.length)

        socket.sendNative(message)
      }

      const preparedMessage = SocketWrapper.prepareMessage(sharedMessages)
      for (const socket of sockets) {
        if (!uniqueSenders.has(socket)) {
          socket.sendPrepared(preparedMessage)
        }
      }
      SocketWrapper.finalizeMessage(preparedMessage)

      subscription.sharedMessages = ''
      subscription.uniqueSenders.clear()
    }

    this._pending.clear()
  }
}

module.exports = SubscriptionRegistry
