/**
 * Create a distributed ring and partition data.
 * @author Alessandro Pio Ardizio
 * @since 0.1
 */
'use strict'

const partitioner = require('./partitioner')
// --------------------- CONFIG ---------------------
const log = require('./logger')
const { port: peerPort, monitoringPort } = require('./config')
const os = require('os')
const hostname = os.hostname()
// --------------------- CONFIG ---------------------

const RedisServer = require('redis-server');
const net = require('net')
const util = require('./util')
const heartbeatCheck = require('./heartcheck')

const nodeFetcher = require('./nodefetcher')


// --------------------- CONSTANTS ---------------------
const {
  NODE_ADDED,
  HEART_BEAT,
  WELCOME,
  RECONNECT,
  BOOTSTRAP,
  MESSAGE_SEPARATOR
} = require('./constants')
// --------------------- CONSTANTS ---------------------

// --------------------- DS ---------------------
/** mantain for each peer the last heart beat. */
const heart = new Map()
/** Used for reconnection when a seed node die. */
/* Addresses will be an array so that is more simple to exchange it as object during socket communication */
const addresses = []

// --------------------- DS ---------------------

// --------------------- CORE ---------------------
/**
 * Create seed node server.
 * It will wait for client connections and will broadcast gossip info.
 */
const createServer = (redisConfigured) => {
  log.info('Becoming leader...')
  log.info('Redis is configured: ' + redisConfigured)

  if (redisConfigured === false) {
    log.info("Redis not configured... starting server")
    const redisServer = new RedisServer({
      port: 6379,
    })
    redisServer.open((err) => {
      if (err === null) {
        log.info("Redis server started")
      }
    })
  }

  var server = net.createServer(client => {
    client.setNoDelay(true)
    log.info(`New Client connected host ${JSON.stringify(client.address())}`)
    // client termination handling.
    client.on('end', () => clientDisconnected(client))
    client.on('error', e => log.error(`client error ${e}`))
    // data received.
    client.on('data', data => peerMessageHandler(data, client))
    // put client connection in the map , and assign partitions.
  })
  heartbeatCheck(heart, addresses)
  server.listen(peerPort, '0.0.0.0', function () {
    log.info('server is listening')
    // do redis stuff after server starts - so clients can connect before they try
    // to leader up
    nodeFetcher(addresses)
  })

  return server
}

const clientDisconnected = client => {
  log.info(`A node is removed from the cluster ${JSON.stringify(client.address())}, waiting heart check to rebalance partitions`)
}

// --------------------- CORE ---------------------

// --------------------- MESSAGING ---------------------

const peerMessageHandler = (data, client) => {
  const stringData = data.toString()
  const arrayData = stringData.split(MESSAGE_SEPARATOR)

  arrayData.forEach(e => {
    if (e.length <= 0) return
    const jsonData = JSON.parse(e)
    const type = jsonData.type
    log.debug(`Receveid a message with type ${type}`)
    const msg = jsonData.msg
    if (type === HEART_BEAT) {
      heart.set(jsonData.id, Date.now())
    } else if (type === BOOTSTRAP) {
      bootstrapClient(client, msg)
    }
    else if (type === RECONNECT) {
      reconnectClient(client, msg)
    }
    // handle all types of messages.
  })
}

function reconnectClient(client, msg) {
  let cliendId = msg.id
  let clientPriority = msg.priority
  let clientHostname = msg.hostname
  let clientRedisPriority = msg.redisPriority
  console.log("CLIENTREDISPRIORITY:", clientRedisPriority)

  let assignedPartitions = partitioner.assignPartitions(client, addresses)
  heart.set(cliendId, Date.now())
  addresses.push({
    client: client,
    hostname: clientHostname,
    port: client.localPort,
    id: cliendId,
    partitions: assignedPartitions,
    priority: clientPriority,
    redisPriority: clientRedisPriority,

  })
  let welcome = {
    type: WELCOME,
    msg: addresses,
    id: cliendId,
    priority: clientPriority,
    redisPriority: clientRedisPriority,
    partitions: assignedPartitions
  }
  // sent ring info to the new peer.
  client.write(JSON.stringify(welcome) + MESSAGE_SEPARATOR)
  util.broadcastMessage(addresses, { type: NODE_ADDED, msg: addresses })
}

/**
 *  After the server get the hostname , it will send a welcome message to the client.
 * @param {*} client client connected
 * @param {*} hostname  hostname of the client
 */
function bootstrapClient(client, hostname) {

  // new host, this is used for the replica-priority. We don't manage it so long as its
  // higher 
  let clientRedisPriority = addresses.length ? Math.max(...addresses.map(o => o.redisPriority)) : 0

  clientRedisPriority++

  //this needs to come from addresses - and if not set then last in the queue
  // otherwise it gets reset every rebalance. Should stay the same
  const priority = addresses.length + 1


  const cliendId = generateID()
  const assignedPartitions = partitioner.assignPartitions(client, addresses)
  heart.set(cliendId, Date.now())
  addresses.push({
    client: client,
    hostname: hostname,
    port: client.localPort,
    id: cliendId,
    partitions: assignedPartitions,
    priority: priority,
    redisPriority: clientRedisPriority,

  })
  const welcome = {
    type: WELCOME,
    msg: addresses,
    id: cliendId,
    priority: priority,
    redisPriority: clientRedisPriority,
    partitions: assignedPartitions
  }
  // sent ring info to the new peer.
  client.write(JSON.stringify(welcome) + MESSAGE_SEPARATOR)
  util.broadcastMessage(addresses, { type: NODE_ADDED, msg: addresses })
}

// --------------------- MESSAGING ---------------------
/**
 * Return an id to be associated to a node.
 */
const generateID = () => {
  return Math.random()
    .toString(36)
    .substring(7)
}

const ringInfo = () => {
  return addresses
}

// --------------------- MONITORING ---------------------
const express = require('express')
const cors = require('cors')
const app = express()
app.use(cors())

app.get('/status', (req, res) => {
  log.info('Leader status request received')
  // return only needed info.
  const response = ringInfo().map(node => ({
    partitions: node.partitions,
    hostname: node.hostname,
    port: node.port,
    id: node.id,
    priority: node.priority
  }))
  // put yourself as leader into the cluster info.
  response.push({ partitions: [], hostname: hostname, port: peerPort })
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(response, null, 2))
})

const startMonitoring = () => {
  app.listen(monitoringPort)
  log.info(`Server is monitorable at the port ${monitoringPort}`)
}

module.exports = {
  createServer: createServer,
  defaultPartitioner: partitioner.defaultPartitioner,
  startMonitoring: startMonitoring,
  ring: ringInfo
}
