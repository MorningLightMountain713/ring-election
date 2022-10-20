/**
 * This is designed to log with winston library.
 *
 * @link https://www.npmjs.com/package/winston#logging-levels , info by default
 */
'use strict'
const winston = require('winston')
const { nodeEnv, logLevel } = require('./config')
const { timestamp, combine, json } = winston.format

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.json(),
  transports: [
    // - Write to all logs with level `info` and below to `combined.log`
    // - Write all logs error (and below) to `error.log`.
    new winston.transports.File({
      filename: 'cerebro.error.log',
      level: 'error'
    }),
    new winston.transports.File({ filename: 'cerebro.log' })
  ]
})

// if in dev environment , log to console.
if (nodeEnv === 'dev') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.json(),
    })
  )
}

module.exports = logger
