var C = require( '../constants/constants' ),
	SubscriptionRegistry = require( '../utils/subscription-registry' ),
	ListenerRegistry = require( '../listen/listener-registry' ),
	messageParser = require( '../message/message-parser' ),
	messageBuilder = require( '../message/message-builder' ),
	utils = require( '../utils/utils' ),
	EventEmitter = require( 'events' ).EventEmitter,
	LRU = require('lru-cache');

/**
 * The entry point for record related operations
 *
 * @param {Object} options deepstream options
 */
var RecordHandler = function( options ) {
	this._options = options;
	this._subscriptionRegistry = new SubscriptionRegistry( options, C.TOPIC.RECORD );
	this._listenerRegistry = new ListenerRegistry( C.TOPIC.RECORD, options, this._subscriptionRegistry );
	this._subscriptionRegistry.setSubscriptionListener( this._listenerRegistry );
	this._dataTransforms = this._options.dataTransforms;
	this._hasReadTransforms = this._dataTransforms && this._dataTransforms.has( C.TOPIC.RECORD, C.ACTIONS.READ );
	this._hasUpdateTransforms = this._dataTransforms && this._dataTransforms.has( C.TOPIC.RECORD, C.ACTIONS.UPDATE );
	this._transitions = {};
	this._permissionHandler = this._options.permissionHandler;
	this._logger = this._options.logger;
	this._recordRequestsInProgress = {};
	this._messageConnector = this._options.messageConnector
	this._storage = this._options.storage;
	this._storage.on('change', this._onStorageChange.bind( this ) );
	this._cache = new LRU({ max: 1e4 });
};

/**
 * Handles incoming record requests.
 *
 * Please note that neither CREATE nor READ is supported as a
 * client send action. Instead the client sends CREATEORREAD
 * and deepstream works which one it will be
 *
 * @param   {SocketWrapper} socketWrapper the sender
 * @param   {Object} message parsed and validated deepstream message
 *
 * @public
 * @returns {void}
 */
RecordHandler.prototype.handle = function( socketWrapper, message ) {

	/*
	 * All messages have to provide at least the name of the record they relate to
	 * or a pattern in case of listen
	 */
	if( !message.data || message.data.length < 1 ) {
		socketWrapper.sendError( C.TOPIC.RECORD, C.EVENT.INVALID_MESSAGE_DATA, message.raw );
		return;
	}

	/*
	 * Return the record's contents and subscribes for future updates.
	 * Creates the record if it doesn't exist
	 */
	if( message.action === C.ACTIONS.CREATEORREAD ) {
		this._createOrRead( socketWrapper, message );
		return;
	}

	/*
	 * Return the current state of the record in cache or db
	 */
	if( message.action === C.ACTIONS.SNAPSHOT ) {
		this._snapshot( socketWrapper, message );
		return;
	}

	/*
	 * Handle complete (UPDATE)
	 */
	if( message.action === C.ACTIONS.UPDATE ) {
		this._update( socketWrapper, message );
		return;
	}

	/*
	 * Unsubscribes (discards) a record that was previously subscribed to
	 * using read()
	 */
	if( message.action === C.ACTIONS.UNSUBSCRIBE ) {
		this._unsubscribe( socketWrapper, message );
		return;
	}

	/*
	 * Listen to requests for a particular record or records
	 * whose names match a pattern
	 */
	if( message.action === C.ACTIONS.LISTEN ||
		message.action === C.ACTIONS.UNLISTEN ||
		message.action === C.ACTIONS.LISTEN_ACCEPT ||
		message.action === C.ACTIONS.LISTEN_REJECT ||
		message.action === C.ACTIONS.LISTEN_SNAPSHOT ) {
		this._listenerRegistry.handle( socketWrapper, message );
		return;
	}

	/*
	 * Default for invalid messages
	 */
	this._logger.log( C.LOG_LEVEL.WARN, C.EVENT.UNKNOWN_ACTION, message.action );

	if( socketWrapper.sendError ) {
		socketWrapper.sendError( C.TOPIC.RECORD, C.EVENT.UNKNOWN_ACTION, 'unknown action ' + message.action );
	}
};

/**
 * Sends the records data current data once loaded from the cache, and null otherwise
 *
 * @param {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 * @private
 * @returns {void}
 */
RecordHandler.prototype._snapshot = async function( socketWrapper, message ) {
	const recordName = message.data[ 0 ];

	if ( await this._permissionAction( C.ACTIONS.SNAPSHOT, recordName, socketWrapper ) ) {
		try {
			const record = await this._getRecord( recordName );
			this._sendRecord( recordName, record || { _v: 0, _d: {}	}, socketWrapper );
		} catch ( error ) {
			socketWrapper.sendError( C.TOPIC.RECORD, C.ACTIONS.SNAPSHOT, [ recordName, error ] );
		}
	}
};

/**
 * Tries to retrieve the record and creates it if it doesn't exist. Please
 * note that create also triggers a read once done
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._createOrRead = async function( socketWrapper, message ) {
	const recordName = message.data[ 0 ];

	try {
		const record = await this._getRecord( recordName );
		if( record ) {
			this._read( recordName, record, socketWrapper );
		}
		else if ( await this._permissionAction( C.ACTIONS.CREATE, recordName, socketWrapper) ) {
			this._create( recordName, socketWrapper );
		}
	} catch ( error ) {
		socketWrapper.sendError( C.TOPIC.RECORD, C.ACTIONS.CREATE, [ recordName, error ] );
	}
};

 /**
 * Applies both full and partial updates. Creates a new record transition that will live as long as updates
 * are in flight and new updates come in
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._update = function( socketWrapper, message ) {
	const recordName = message.data[ 0 ];

	if( message.data.length < 3 ) {
		socketWrapper.sendError( C.TOPIC.RECORD, C.EVENT.INVALID_MESSAGE_DATA, message.data[ 0 ] );
		return;
	}

	const version = parseInt( message.data[ 1 ], 10 );

	if( isNaN( version ) ) {
		socketWrapper.sendError( C.TOPIC.RECORD, C.EVENT.INVALID_VERSION, [ recordName, version ] );
		return;
	}

	const json = utils.JSONParse( message.data[ 2 ] );

	if ( json.error ) {
		socketWrapper.sendError( C.TOPIC.RECORD, C.EVENT.INVALID_MESSAGE_DATA, message.raw );
		return;
	}

	const record = {
		_v: version,
		_d: json.value
	};

	// Always write to storage (even if wrong version) in order to resolve conflicts
	if ( socketWrapper !== C.SOURCE_STORAGE_CONNECTOR && socketWrapper !== C.SOURCE_MESSAGE_CONNECTOR ) {
		this._storage.set( recordName, record, this._onStorageResponse.bind( this ) );
	}

	if ( this._cache.has( recordName ) && this._cache.get( recordName )._v >= record._v ) {
		return;
	}

	this._cache.set( recordName, record );

	if( this._hasUpdateTransforms ) {
		this._broadcastTransformedUpdate( transformUpdate, recordName, message, socketWrapper );
	} else {
		this._subscriptionRegistry.sendToSubscribers( recordName, message.raw, socketWrapper );
	}

	if( socketWrapper !== C.SOURCE_MESSAGE_CONNECTOR && socketWrapper !== C.SOURCE_STORAGE_CONNECTOR ) {
		this._messageConnector.publish( C.TOPIC.RECORD, message );
	}
};

RecordHandler.prototype._unsubscribe = function( socketWrapper, message ) {
	const recordName = message.data[ 0 ];
	this._subscriptionRegistry.unsubscribe( recordName, socketWrapper );
}
/**
 * Creates a new, empty record and triggers a read operation once done
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._create = function( recordName, socketWrapper ) {
	const record = { _v: 0, _d: {} };

	// store the records data in the cache
	this._cache.set( recordName, record );

	this._read( recordName, record, socketWrapper );

	// store the record data in the persistant storage independently and don't wait for the result
	this._storage.set( recordName, record, ( error ) => {
		if( error ) {
			this._logger.log( C.LOG_LEVEL.ERROR, C.EVENT.RECORD_CREATE_ERROR, 'storage:' + error );
		}
	} );
};

/**
 * Subscribes to updates for a record and sends its current data once done
 *
 * @param {String} recordName
 * @param {Object} record
 * @param {SocketWrapper} socketWrapper the socket that send the request
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._read = async function( recordName, record, socketWrapper ) {
	if ( await this._permissionAction( C.ACTIONS.READ, recordName, socketWrapper) ) {
		this._subscriptionRegistry.subscribe( recordName, socketWrapper );
		this._sendRecord( recordName, record, socketWrapper );
	}
};

/**
 * Sends the records data current data once done
 *
 * @param {String} recordName
 * @param {Object} record
 * @param {SocketWrapper} socketWrapper the socket that send the request
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._sendRecord = function( recordName, record, socketWrapper ) {
	let data = record._d;

	if( this._hasReadTransforms ) {
		data = this._dataTransforms.apply(
			C.TOPIC.RECORD,
			C.ACTIONS.READ,
			JSON.parse( JSON.stringify( data ) ),
			{ recordName: recordName, receiver: socketWrapper.user }
		);
	}

	socketWrapper.sendMessage( C.TOPIC.RECORD, C.ACTIONS.READ, [ recordName, record._v, data ] );
};

/**
 * Called by _update if registered transform functions are detected. Disassembles
 * the message and invokes the transform function prior to sending it to every individual receiver
 * so that receiver specific transforms can be applied.
 *
 * @param   {Boolean} transformUpdate is a update transform function registered that applies to this update?
 * @param   {String} recordName       the record name
 * @param   {Object} message          a parsed deepstream message object
 * @param   {SocketWrapper|String} originalSender  the original sender of the update or a string pointing at the messageBus
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._broadcastTransformedUpdate = function( transformUpdate, recordName, message, originalSender ) {
	const receivers = this._subscriptionRegistry.getLocalSubscribers( recordName );
	const metaData = {
		recordName: recordName,
		version: parseInt( message.data[ 1 ], 10 )
	};
	const unparsedData = message.data[ transformUpdate ? 2 : 3 ];
	const messageData = message.data.slice( 0 );

	if( !receivers ) {
		return;
	}

	for( let i = 0; i < receivers.length; i++ ) {
		if( receivers[ i ] === originalSender ) {
			continue;
		}
		metaData.receiver = receivers[ i ].user;

		const data = this._dataTransforms.apply( message.topic, message.action, JSON.parse( unparsedData ), metaData );
		messageData[ 2 ] = JSON.stringify( data );

		receivers[ i ].sendMessage( message.topic, message.action, messageData );
	}
};

/**
 * Executes or schedules a callback function once all transitions are complete
 *
 * This is called from the PermissionHandler destroy method, which
 * could occur in cases where 'runWhenRecordStable' is never called,
 * such as when no cross referencing or data loading is used.
 *
 * @param   {String}   recordName the name of the record
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype.removeRecordRequest = function( recordName ) {
	if( !this._recordRequestsInProgress[ recordName ] ) {
		return;
	}

	if( this._recordRequestsInProgress[ recordName ].length === 0 ) {
		delete this._recordRequestsInProgress[ recordName ];
		return;
	}

	this._recordRequestsInProgress[ recordName ].splice( 0, 1 )[ 0 ]();
};

/**
 * Executes or schedules a callback function once all record requests are removed.
 * This is critical to block reads until writes have occured for a record, which is
 * only from permissions when a rule is required to be run and the cache has not
 * verified it has the latest version
 *
 * @param   {String}   recordName the name of the record
 * @param   {Function} callback   function to be executed once all writes to this record are complete
 *
 * @public
 * @returns {void}
 */
RecordHandler.prototype.runWhenRecordStable = function( recordName, callback ) {
	if( !this._recordRequestsInProgress[ recordName ] ) {
		this._recordRequestsInProgress[ recordName ] = [];
		callback();
	} else {
		this._recordRequestsInProgress[ recordName ].push( callback );
	}
};

/**
 * A secondary permissioning step that is performed once we know if the record exists (READ)
 * or if it should be created (CREATE)
 *
 * @param   {String} action          One of C.ACTIONS, either C.ACTIONS.READ or C.ACTIONS.CREATE
 * @param   {String} recordName      The name of the record
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Function} successCallback A callback that will only be invoked if the operation was successful
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._permissionAction = function( action, recordName, socketWrapper ) {
	return new Promise( ( resolve, reject ) => {
		const message = {
			topic: C.TOPIC.RECORD,
			action: action,
			data: [ recordName ]
		};

		const onResult = ( error, canPerformAction ) => {
			if( error !== null ) {
				socketWrapper.sendError( message.topic, C.EVENT.MESSAGE_PERMISSION_ERROR, error.toString() );
				resolve( false );
			}
			else if( !canPerformAction ) {
				socketWrapper.sendError( message.topic, C.EVENT.MESSAGE_DENIED, [ recordName, action  ] );
				resolve( false );
			}
			else {
				resolve( true );
			}
		};

		this._permissionHandler.canPerformAction(
			socketWrapper.user,
			message,
			onResult,
			socketWrapper.authData
		);
	})

};

RecordHandler.prototype._getRecord = function ( recordName ) {
	return this._cache.has( recordName )
		? Promise.resolve( this._cache.get( recordName ) )
		: this._getRecordFromStorage( recordName );
}

RecordHandler.prototype._getRecordFromStorage = function ( recordName ) {
	return Promise
		.race( [
			new Promise( ( resolve, reject ) => setTimeout( () => reject( {
				event: C.EVENT.STORAGE_RETRIEVAL_TIMEOUT,
				message: recordName
			} ), this._options.storageRetrievalTimeout ) ),
			new Promise( ( resolve, reject ) => this._storage.get( recordName, ( error, record ) => {
				if ( error ) {
					reject( {
						event: C.EVENT.RECORD_LOAD_ERROR,
						message: 'error while loading ' + recordName + ' from storage:' + error.toString()
					} );
				} else {
					this._cache.set( recordName, record );
					resolve( record );
				}
			} ) )
		] )
		.catch( error => {
			this._logger.log( C.LOG_LEVEL.ERROR, error.event, error.message );
			throw error.message;
		} );
}

/**
 * Callback for responses returned by storage.set()
 *
 * @param   {String} error
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._onStorageResponse = function( error ) {
	if( error ) {
		this._logger.log( C.LOG_LEVEL.ERROR, C.EVENT.RECORD_UPDATE_ERROR, error );
	}
};

/**
 * Callback for changes from storage
 *
 * @param   {String} error
 *
 * @private
 * @returns {void}
 */
RecordHandler.prototype._onStorageChange = async function( recordName, version ) {
	if ( this._cache.has( recordName ) && this._cache.get( recordName )._v >= version ) {
		return;
	}

	try {
		const record = await this._getRecord( recordName );
		if ( record ) {
			this._update( C.SOURCE_STORAGE_CONNECTOR, { data: [ recordName, version, JSON.stringify( record ) ] } );
		}
	} catch ( error ) {
		// Do nothing...
	}
}

module.exports = RecordHandler;
