/**
 * @fileoverview This module is designed to collect all configurations for the application.
 */

'use strict'

module.exports = {
  appName: process.env.APP_NAME,
  seedNodes: process.env.SEED_NODES,
  orchestrator: process.env.APP_NAME ? "FLUX" : "MANUAL",
  // port to serve HTTP requests
  commsPort: process.env.COMMS_PORT || 3000,
  // winston log level , info by default
  logLevel: process.env.LOG_LEVEL || 'info',
  // env description
  // this kind of info is important to determinate if log should be on console or not and for other stuff
  nodeEnv: process.env.NODE_ENV || 'dev',
  // data source connection string
  timeToReconnect: process.env.TIME_TO_RECONNECT || 3000,
  timeToBecomeSeed: process.env.TIME_TO_BECOME_SEED || 1000,
  monitoringPort: process.env.MONITORING_PORT || 9000,
  heartbeatFrequency: process.env.HEART_BEAT_FREQUENCY || 1000,
  heartbeatCheckFrequency: process.env.HEART_BEAT_CHECK_FREQUENCY || 3000,
  maxInactiveTime: process.env.MAX_INACTIVE_TIME || 9000,
  numPartitions: process.env.NUM_PARTITIONS || 10,
  minFollowers: process.env.MIN_FOLLOWERS || 3,
  // redis
  redisPort: process.env.REDIS_PORT || 6379,
  sentinelPort: process.env.SENTINEL_PORT || 26379
}
