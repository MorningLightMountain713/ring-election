/**
 * Create a distributed ring and partition data.
 */
'use strict'

const partitioner = require('./partitioner')

// for sentinel config
const dedent = require('dedent-js');
const tmp = require('tmp')
const fs = require('fs')
// --------------------- CONFIG ---------------------
const log = require('./logger')
const { commsPort: peerPort, monitoringPort, sentinelPort, redisPort } = require('./config')
const os = require('os')
const hostname = os.hostname()
// --------------------- CONFIG ---------------------

// const RedisServer = require('redis-server');
const net = require('net')
const util = require('./util')
const heartbeatCheck = require('./heartcheck')
const Redis = require("ioredis")
const nodeFetcher = require('./nodefetcher')
const NTPServer = require('ntp-time').Server;



// --------------------- CONSTANTS ---------------------
const {
  STARTUP,
  STARTUP_REPLY,
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRedisConnection(host, port = 6379) {
  // Set maxRetriesPerRequest to null to disable this behavior, and every command will wait forever until the connection is alive again (which is the default behavior before ioredis v4).
  console.log(host, port)
  const redis = new Redis({
    host: host,
    port: port,
    lazyConnect: true,
    // default
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
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
 * Create seed node server.
 * It will wait for client connections and will broadcast gossip info.
 */
async function createServer(server, connectedClients, redisConfigured, myIp, priorNodeCount) {
  log.info('Leader starting...')
  // was using this to conditionally set up redis but just try / catch
  log.info(`Redis is alreading running: ${redisConfigured}`)
  // couple of contexts here. Either we are the OG leader, and we've never setup redis
  // before, or the OG leader has fallen off, and we are the new leader. In which case
  // weve already setup redis before

  // sentinel needs to be reconfigured regardless of if we're OG leader or not
  // leader doesn't have access to external ip, (nat reflection) so, couple of options
  // try socat redirect or just connect on 127.0.0.1. The only problem with 127.0.0.1
  // is that when a follower becomes leader we have to reset the sentinel config.
  // can either use ioredis to set config

  // monitoring leader (ourselves) on raw ports without socat. This should be okay as
  // we should never get demoted to follower (we would just restart)

  if (connectedClients) {
    for (let client of connectedClients) {
      client.removeAllListeners('end')
      client.removeAllListeners('error')
      client.removeAllListeners('data')
      client.on('end', () => clientDisconnected(client))
      client.on('error', e => log.error(`client error ${e}`))
      // data received.
      client.on('data', data => peerMessageHandler(data, client))
    }
  }

  if (!redisConfigured) { // we're the OG leader
    redisConfigured = true

    let sentinel = await getRedisConnection("flux_cerebro_sentinel", 26379)
    sentinel.on("error", (err) => {
      console.log(err)
    })

    const callSentinel = ["call", "sentinel"]
    const SentinelconfigSet = [...callSentinel, "CONFIG", "SET"]

    const removeLeader = [...callSentinel, "REMOVE", "LEADER"]
    const monitorLeader = [...callSentinel, "MONITOR", "LEADER", `${myIp}`, `${redisPort}`, 2]
    const announcePort = [...SentinelconfigSet, "announce-port", `${sentinelPort}`]
    const announceIp = [...SentinelconfigSet, "announce-ip", `${myIp}`]
    const downAfter = [...callSentinel, "SET", "LEADER", "down-after-milliseconds", 5000]
    const failOver = [...callSentinel, "SET", "LEADER", "failover-timeout", 15000]
    const parallelSyncs = [...callSentinel, "SET", "LEADER", "parallel-syncs", 1]

    const sentinelCommands = [removeLeader, monitorLeader, announceIp, announcePort, downAfter, failOver, parallelSyncs]

    sentinel.pipeline(sentinelCommands).exec(async (err, results) => {
      if (err) {
        console.log(`Error configuring Redis: ${err}`)
      }
      // console.log(results)
      console.log("Sentinel configured")
      sentinel.disconnect()
    })
  }

  let connectionListener = client => {
    client.setNoDelay(true)
    log.info(`New Client connected (leader connection event) host ${JSON.stringify(client.address())}`)
    // client termination handling.
    client.on('end', () => clientDisconnected(client))
    client.on('error', e => log.error(`client error ${e}`))
    // data received.
    client.on('data', data => peerMessageHandler(data, client))
    // put client connection in the map , and assign partitions.
  }
  heartbeatCheck(heart, addresses)

  if (!server) {
    const server = net.createServer(connectionListener)
    server.listen(3000, '0.0.0.0', function () {
      log.info('server is listening')
      // from noticing other leader is dead, took 1.1 seconds to become leader

      nodeFetcher(addresses, priorNodeCount)
    })
  } else {
    server.on("connection", connectionListener)
    nodeFetcher(addresses, priorNodeCount)
  }
  return server
}


const clientDisconnected = client => {
  log.info(`A node is removed from the cluster ${JSON.stringify(client.address())}, waiting heart check to rebalance partitions`)
}

// --------------------- CORE ---------------------

// --------------------- MESSAGING ---------------------

let buff = ""
const peerMessageHandler = (data, client) => {
  // need to make a message magic starter thing, so if rogue agent connects, we can fuck
  // them off without messing with our chi
  let stringData = data.toString()

  // testing
  // console.log(typeof data)
  // console.log(Buffer.byteLength(stringData, "utf-8"))
  // console.log(stringData)

  // we will catch the rest of the message in the next event
  // this could be two messages? shouldn't matter
  if (!stringData.endsWith(MESSAGE_SEPARATOR)) {
    buff += stringData
    return
  }

  if (buff) {
    stringData = buff + stringData
    buff = ""
  }

  const arrayData = stringData.split(MESSAGE_SEPARATOR)

  arrayData.forEach(e => {
    if (e.length <= 0) return
    const jsonData = JSON.parse(e)
    const type = jsonData.type
    log.debug(`Received a message with type ${type}`)
    const msg = jsonData.msg
    if (type === HEART_BEAT) {
      heart.set(jsonData.id, Date.now())
    } else if (type === BOOTSTRAP) {
      bootstrapClient(client, msg)
    }
    else if (type === RECONNECT) {
      reconnectClient(client, msg)
    } else if (type === STARTUP) {
      console.log("Received startup message, sending reply...")
      client.write(MESSAGE_SEPARATOR + JSON.stringify({ type: STARTUP_REPLY, isServer: true, standDown: true }) + MESSAGE_SEPARATOR)
    }
  })
  // handle all types of messages.
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
  client.write(MESSAGE_SEPARATOR + JSON.stringify(welcome) + MESSAGE_SEPARATOR)
  util.broadcastMessage(addresses, { type: NODE_ADDED, msg: addresses })
}

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
  client.write(MESSAGE_SEPARATOR + JSON.stringify(welcome) + MESSAGE_SEPARATOR)
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
