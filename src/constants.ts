export * from '@deepstream/protobuf/types/all'
export * from '@deepstream/protobuf/types/messages'

export enum STATES {
    LOGGER_INIT = 'LOGGER_INIT',
    SERVICE_INIT = 'SERVICE_INIT',
    HANDLER_INIT = 'HANDLER_INIT',
    CONNECTION_ENDPOINT_INIT = 'CONNECTION_ENDPOINT_INIT',
    PLUGIN_INIT = 'PLUGIN_INIT',
    RUNNING = 'RUNNING',

    PLUGIN_SHUTDOWN = 'PLUGIN_SHUTDOWN',
    CONNECTION_ENDPOINT_SHUTDOWN = 'CONNECTION_ENDPOINT_SHUTDOWN',
    HANDLER_SHUTDOWN = 'HANDLER_SHUTDOWN',
    SERVICE_SHUTDOWN = 'SERVICE_SHUTDOWN',
    LOGGER_SHUTDOWN = 'LOGGER_SHUTDOWN',
    STOPPED = 'STOPPED'
}
