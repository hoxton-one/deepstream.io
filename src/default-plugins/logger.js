'use strict';

const winston = require( 'winston' );
const colors = require( 'winston/lib/winston/config' );
const winstonRotateFile = require( 'winston-daily-rotate-file' );
const utils = require( '../utils/utils' );

const LEVELS_AND_COLORS = {
	// winston default levels (npm style)
	levels: {
		error: 0,
		warn: 1,
		info: 2,
		verbose: 3,
		debug: 4,
		silly: 5
	},
	// reverse lookup array
	lookup: [
		'debug',
		'info',
		'warn',
		'error'
	],
	// winston default colors (npm style)
	colors: {
		error: 'red',
		warn: 'yellow',
		info: 'green',
		verbose: 'cyan',
		debug: 'blue',
		silly: 'magenta'
	}
};

/**
* Logs to the operatingsystem's standard-out and standard-error streams.
*
* Consoles / Terminals as well as most log-managers and logging systems
* consume messages from these streams
*
*/
class Logger  {
	constructor( loggerConfig ) {
		this._loggerConfig = loggerConfig;
		this._transports = [];
		this._initializeTransports();

		this._logger = new ( winston.Logger )( {
			transports: this._transports,
			levels: LEVELS_AND_COLORS.levels
		} );
		winston.addColors( LEVELS_AND_COLORS.colors );
		this.isReady = true;
	}

	// this logger is sync, no need to implement event handler
	// on() {}
	// once() {}
	// off() {}

	_initializeTransports() {
		if ( this._loggerConfig && this._loggerConfig.type === 'default' ) {
			const loggers = this._loggerConfig.options;
			for ( let i = 0; i < loggers.length; i++ ) {
				const logger = this._loggerConfig.options[i];
				if ( logger.type === 'console' ) {
					this._transports.push( createConsoleTransport( logger.options ) );
				} else if ( logger.type === 'file' ) {
					if ( !logger.options && !logger.options.filename ) {
						throw new Error( 'file logger needs a filename, but found: ' + logger.options );
					}
					this._transports.push(
						new ( winston.transports.File )( logger.options )
					);
				} else if ( logger.type === 'time' ) {
					this._transports.push(
						new ( winstonRotateFile )( logger.options )
					);
				} else if ( logger.type === 'custom' ) {
					const requirePath = utils.lookupRequirePath( logger.path );
					const clazz = require( requirePath );
					this._transports.push(
						new ( clazz )( logger.options )
					);
				} else {
					throw new Error( `logger type ${logger.type} not supported` );
				}
			}
		} else {
			// default logger (behaviour like the std-out-logger)
			this._transports.push( createConsoleTransport( this._loggerConfig ) );
		}
	}

	/**
	* Logs a line
	*
	* @param  {Number} logLevel  One of the C.LOG_LEVEL constants
	* @param  {String} event     One of the C.EVENT constants
	* @param  {String} logMessage Any string
	*
	* @public
	* @returns {void}
	*/
	log( logLevel, event, logMessage ) {
		this._logger.log( LEVELS_AND_COLORS.lookup[logLevel], logMessage, {event: event} );
	}

	/**
	* Sets the log-level. This can be called at runtime.
	*
	* @param {Number} logLevel One of the C.LOG_LEVEL constants
	*
	* @public
	* @returns {void}
	*/
	setLogLevel( logLevel ) {
		const transportNames = Object.keys( this._logger.transports );
		for ( let i = 0; i < transportNames.length; i++ ) {
			const name = transportNames[i];
			const transport = this._logger.transports[name];
			transport.level = LEVELS_AND_COLORS.lookup[logLevel];
		}
	}
}

function createConsoleTransport( loggerConfig ) {
	const defaults = {
		level: 'info',
		colorize: true,
		stderrLevels: ['error', 'warn'],
		formatter: ( options ) => {
			const message = ( options.meta && options.meta.event ? options.meta.event : '' ) +
			' | ' +
			( options.message ? options.message : '' );
			if ( options.colorize ) {
				return colors.colorize( options.level, message );
			}
			return message;
		}
	};
	return new ( winston.transports.Console )( utils.merge( defaults, loggerConfig ) );
}

module.exports = Logger;
