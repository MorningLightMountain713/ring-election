'use strict'
/**
 * This will emit events
 * @exports a custom event emitter that will emit events for node added/removed, leader elected , partitions assigned/removed
 */
const EventEmitter = require('events')
/**
 * Event emitter to check nodes added and removed from the cluster.
 */
class RingEmitter extends EventEmitter { }
const ringEmitter = new RingEmitter()

module.exports = ringEmitter
