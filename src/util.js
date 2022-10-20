/**
 * Util functions to search and remove data from data structures.
 */
'use strict'

const Redis = require("ioredis")
const Rx = require('@reactivex/rxjs')
const log = require('./logger')
const { MESSAGE_SEPARATOR } = require('./constants')

// /**
//  * Search a client by instance.
//  * @param {*} id the client  to search
//  * @param {Array} ds an array
//  * @returns the entry in the map.
//  */
// const searchClient = (id, networkView) => {
//   let result
//   Rx.Observable.from(ds)
//     .filter(e => e.client === client)
//     .first()
//     .subscribe(host => (result = host), e => log.error(e))
//   return result
// }

function generateId() {
  return Math.random()
    .toString(36)
    .substring(7)
}

/**
 * Search a client by client priority.
 * @param {*} priority the priority to search
 * @param {Array} ds an array
 * @returns the entry in the map.
 */
const searchClientByPriority = (priority, ds) => {
  let result
  Rx.Observable
    .from(ds)
    .filter(e => e.priority === priority)
    .first()
    .subscribe(host => (result = host), e => log.error(e))
  return result
}

/**
 * Search a client by client Id.
 * @param {int} id id to search
 * @param {Array} ds a map with id as keys.
 * @returns the entry in the map.
 */
const searchClientById = (id, ds) => {
  let result
  Rx.Observable
    .from(ds)
    .filter(e => e.id === id)
    .first()
    .subscribe(host => (result = host), e => log.error(e))
  return result
}

/**
 * Broadcast message to each node.
 * @param {Array} addresses , addresses in the cluster.
 * @param {Object} msg , message to sent in broadcast.
 */
const broadcastMessage = (sockets, msg) => {
  console.log(`Broadcasting a ${msg.type} message`)
  if (sockets.size > 0) {
    for (let socket of sockets) {
      socket.write(prepareMessage(msg))
    }
    // Rx.Observable.from(addresses).forEach(host => {
    //   host.client.write(MESSAGE_SEPARATOR + JSON.stringify(msg, getCircularReplacer()) + MESSAGE_SEPARATOR)
    // })
  }
}

function prepareMessage(msg) {
  return MESSAGE_SEPARATOR + JSON.stringify(msg) + MESSAGE_SEPARATOR
}

function writeMessage(socket, msg) {
  console.log(`Sending a ${msg.type} message to ${socket.ip}`)
  socket.write(prepareMessage(msg))
}

const getCircularReplacer = () => {
  const seen = new WeakSet();
  return (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
    }
    return value;
  };
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRedisConnection(host, port = 6379) {
  // Set maxRetriesPerRequest to null to disable this behavior, and every command will wait forever until the connection is alive again (which is the default behavior before ioredis v4).
  const redis = new Redis({
    host: host,
    port: port,
    lazyConnect: true,
    // default
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return null;
    },
  });

  while (redis.status !== "ready") {
    console.log("Connecting to redis...")
    try {
      await redis.connect()
    }
    catch (err) {
      await redis.disconnect()
      await sleep(3000)
      console.log("Retrying...")
    }

  }
  return redis
}

/**
 * @param {Array} first
 * @param {Array} second
 * @param {Array} diff the array to put changes, is optional
 * @returns {Array} an array containing the elements into the first array but not into the second
 */
const checkDiff = (first, second, diff) => {
  first.forEach(value => {
    if (!second.includes(value)) {
      if (!diff) {
        diff = []
      }
      diff.push(value)
    }
  })
  return diff
}

module.exports = {
  // searchClient: searchClient,
  searchClientByPriority: searchClientByPriority,
  searchClientById: searchClientById,
  broadcastMessage: broadcastMessage,
  writeMessage: writeMessage,
  checkDiff: checkDiff,
  prepareMessage: prepareMessage,
  getRedisConnection, getRedisConnection,
  generateId, generateId,
}
