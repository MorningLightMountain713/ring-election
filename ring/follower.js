/**
 * Create a distributed ring and partition data.
 * @author Alessandro Pio Ardizio
 * @since 0.1
 */
'use strict'

// --------------------- CONFIG ---------------------
const os = require('os')

// for sentinel config file
const tmp = require('tmp');
const fs = require('fs');

const hostname = os.hostname()
const log = require('./logger')
const eventEmitter = require('./eventEmitter')
const { timeToReconnect, monitoringPort, timeToBecomeSeed } = require('./config')
let monitor
let leaderConnected
let partitionSize
// --------------------- CONFIG --------------------

const RedisServer = require('redis-server');
const net = require('net')
const heartbeat = require('./heartbeat')
const Rx = require('@reactivex/rxjs')
const { checkDiff } = require('./util')
// node id in the ring.
var id
// priority to be elegible to be a seed node.
var priority
var redisPriority
// Assigned partitions
var assignedPartitions = []

// --------------------- CONSTANTS ---------------------
const {
  NODE_ADDED,
  NODE_REMOVED,
  WELCOME,
  RECONNECT,
  BOOTSTRAP,
  MESSAGE_SEPARATOR,
  BECOME_LEADER,
  PARTITIONS_ASSIGNED,
  PARTITIONS_REVOKED,
  PARTITION_CHANGE
} = require('./constants')
// --------------------- CONSTANTS ---------------------

// --------------------- DS ---------------------
/** Used for reconnection when a seed node die. */
/* Addresses will be an array so that is more simple to exchange it as object during socket communication */
let addresses = []
let redisConfigured = false
let seedNodesTried = 0
// --------------------- DS ---------------------

// --------------------- CORE ---------------------
const seedNodes = process.env.SEED_NODES ? process.env.SEED_NODES.split(',') : getSeedNodes()
const clientSockets = new Set(); // for monitoring

/**
 * Create a socket client to connect the follower to the leader.
 * If there is no leader available , this function will start a server.
 * @returns the client if created , else undefined.
 */
const start = () => {
  const seedNode = detectSeedNode()

  if (seedNodesTried == seedNodes.length) {
    log.info(
      'Unable to connect to any node into the cluster,you will become the leader!'
    )
    seedNodesTried = 0
    startAsLeader(redisConfigured)
    return
  }

  seedNodesTried++

  var client = net.connect(
    {
      host: seedNode.split(':')[0],
      port: seedNode.split(':')[1]
    },
    () => {
      leaderConnected = seedNode
      log.info(`connected to server! Leader node is ${seedNode}`)
    }
  )
  client.setNoDelay(true)
  client.on('end', e => seedEndEvent(client, e))
  client.on('error', e => seedErrorEvent(client, e))
  client.on('data', data => peerMessageHandler(data, client))

  if (id) { // we've already connected to a master before
    client.write(JSON.stringify({ type: RECONNECT, msg: { id: id, priority: priority - 1, hostname: hostname, redisPriority: redisPriority } }) + MESSAGE_SEPARATOR)
  }
  else { // first time
    client.write(JSON.stringify({ type: BOOTSTRAP, msg: hostname }) + MESSAGE_SEPARATOR)

  }
  return client
}

const startAsLeader = (isRedisConfigured) => {
  log.info('Starting as leader...')
  destroySockets(clientSockets) // otherwise it hangs for ages
  monitor.close(() => {
    log.info('Closing monitoring server started previously')
    const leader = require('./leader')
    leader.createServer(isRedisConfigured) // redisConfigured = true
    leader.startMonitoring()
    eventEmitter.emit(BECOME_LEADER)
  })
}

/**
 *
 * @return the node to try to connect
 */
function detectSeedNode() {
  const currentSeedNode = seedNodes.shift()
  seedNodes.push(currentSeedNode)
  log.info(`Connecting to node ${currentSeedNode}`)
  return currentSeedNode
}

async function getNodesRaw() {
  const nodesRaw = await axios.get("https://api.runonflux.io/apps/location?appname=" + APPNAME, {
    timeout: 5 * 1000,
  }).catch((e) => {
    console.log(e);
    return {
      data: {
        status: "error",
        error: "Connection Timeout",
        data: [],
      },
    };
  })
  return nodesRaw.data
}

async function getSeedNodes() {
  const nodes = await getNodesRaw();
  // ToDo: deal with axios error and retry
  const sortedNodeIps = nodes.data.reduce((allNodes, node) => {
    // strip all ports off
    const re = /:[0-9]{1,5}/
    const output = node.ip.replace(re, '');
    allNodes.push(output);
    allNodes.sort()
    return allNodes;
  }, []);
}



// --------------------- CORE ---------------------

// --------------------- MESSAGING ---------------------

/**
 * Method to send data across the cluster
 * @param {*Any} data , data to send to other followers via socket
 * @param {*} replication , the replication factor desired for this data, you can choose a number or LOCAL_QUORUM_REPLICATION,QUORUM_REPLICATION,TOTAL_REPLICATION
 * @since 2.0.0
 */
const sendData = (data, replication) => {
  // TODO implement
}

const peerMessageHandler = (data, client) => {
  const stringData = data.toString()
  const dataArray = stringData.split(MESSAGE_SEPARATOR)

  dataArray.forEach(e => {
    if (e.length <= 0) return
    const jsonData = JSON.parse(e)
    const type = jsonData.type
    const msg = jsonData.msg
    log.debug(`Receveid a message with type ${type}`)
    if (type === WELCOME) {
      seedNodesTried = 0
      // convert array in a map.
      addresses = jsonData.msg
      id = jsonData.id
      priority = jsonData.priority
      redisPriority = jsonData.redisPriority
      log.info(`Id in the ring ${id} , priority in the ring ${priority}, redis priority in the ring ${redisPriority}`)
      log.info(`Assigned partitions : ${jsonData.partitions}`)
      assignedPartitions = jsonData.partitions
      heartbeat(client, id)
      eventEmitter.emit(PARTITIONS_ASSIGNED, assignedPartitions)

      // we get a new welcome message everytime we get a new master, however we only
      // want to start server once
      // this needs an else, it means that we have a new master, so we should update our
      // priority to new priority
      if (!redisConfigured) {
        // redis stuff - this function is way too big
        const sentinelConfig = `
        sentinel monitor LEADER ${leaderConnected.split(':')[0]} 6379 2
        sentinel down-after-milliseconds LEADER 5000
        sentinel failover-timeout LEADER 15000
        sentinel parallel-syncs LEADER 1`

        const sConfigFile = tmp.fileSync();

        fs.writeFileSync(sConfigFile.name, sentinelConfig)

        const redisServer = new RedisServer({
          port: 6379,
          replicaof: leaderConnected.split(':')[0] + " 6379",
          replicaPriority: redisPriority
        })

        redisServer.open((err) => {
          if (err === null) {
            log.info("Redis server started")
          }
          else {
            log.info("Redis ERROR!!!")
            log.info(err)
          }
        });

        const sentinelServer = new RedisServer({
          port: 26379,
          sentinel: true,
          conf: sConfigFile.name,
        })
        sentinelServer.open((err) => {
          if (err === null) {
            log.info("Sentinel server started")
          }
          else {
            log.info("Sentinel ERROR!!!")
            log.info(err)
          }
        });
        redisConfigured = true
      }
      // else { // we need to set redis priority
      //   // this is dogshit
      //   const redis = require('redis');
      //   const client = redis.createClient();

      //   client.on('error', (err) => console.log('Redis Client Error', err));
      //   client.on('ready', async () => {
      //     console.log("THISPRIORITY:", priority)
      //     await client.sendCommand(["CONFIG", "SET", "replica-priority", priority.toString()])
      //     // await client.CONFIG_SET(`replica-priority ${priority}`)
      //   })
      //   client.connect();

      // }

    } else if (type === NODE_ADDED) {
      log.info('New node added in the cluster')
      const oldPartitions = []
      Object.assign(oldPartitions, assignedPartitions)
      addresses = msg
      updatePartitionAssigned(oldPartitions)
    } else if (type === NODE_REMOVED) {
      const removedPriority = jsonData.removedPriority
      if (priority > removedPriority) priority--
      log.info(
        `A node was removed from the cluster , now my priority is ${priority}`
      )
      const oldPartitions = []
      Object.assign(oldPartitions, assignedPartitions)
      addresses = msg
      updatePartitionAssigned(oldPartitions)
    }
    else if (type === PARTITION_CHANGE) {
      partitionSize = msg.partitionSize
      log.info(`Records per partition has changed to ${partitionSize}... updating`)
      // do other partition stuff
    }
    // handle all types of messages.
  })
}

/**
 * Update the partitions assigned to this node.
 * Calculate the diff between old assigned partitions and new and emit the diff.
 * @param {*Array} oldPartitions
 */
const updatePartitionAssigned = (oldPartitions) => {
  Rx.Observable.from(addresses)
    .find(a => a.id === id)
    .subscribe(e => {
      assignedPartitions = e.partitions
    })

  // check assigned and removed partitions
  const revoked = checkDiff(oldPartitions, assignedPartitions)
  const assigned = checkDiff(assignedPartitions, oldPartitions)
  if (revoked) {
    eventEmitter.emit(PARTITIONS_REVOKED, revoked)
  }
  if (assigned) {
    eventEmitter.emit(PARTITIONS_ASSIGNED, assigned)
  }
}

/**
 * Seed node dead , search new seed node and connect to it.
 */
const seedNodeReconnection = () => {
  log.error('Seed node is dead')
  Rx.Observable.from(addresses)
    .find(e => e.priority === 1)
    .subscribe(
      e => {
        log.info(`Find vice seed node with address ${e.hostname}`)
        setTimeout(start, timeToReconnect)
      },
      error => log.error(error),
      () => log.info('Reconnected to seed node')
    )
}

/**
 * Handler for seed node disconnection.
 */
const seedEndEvent = (client, err) => {
  if (err) log.error(`Seed error event : ${err}`)
  log.info('seed node disconnected')
  client.end()
  client.destroy()
  // keep clients updated
  if (priority === 1) {
    log.info(
      'Becoming seed node , clearing server list and waiting for connections'
    )
    assignedPartitions = []

    setTimeout(startAsLeader, timeToBecomeSeed, redisConfigured)
  } else {
    seedNodeReconnection()
  }
}

/**
 * Error handling on sockets.
 * @param {*} client , client disconnected
 * @param {*} e  , error
 */
const seedErrorEvent = (client, e) => {
  log.error(JSON.stringify(e))
  start()
}

// --------------------- MESSAGING ---------------------
/**
 * @returns all the ring info , including leader
 */
const ringInfo = () => {
  return addresses
}
/**
 * @returns the assigned partitions for this follower
 */
const partitions = () => {
  return assignedPartitions
}

// --------------------- MONITORING ---------------------
const express = require('express')
const cors = require('cors')
const app = express()
app.use(cors())
app.get('/status', (req, res) => {
  log.info('Follower status request received')
  // return only needed info.
  const result = ringInfo().map(node => ({
    partitions: node.partitions,
    hostname: node.hostname,
    port: node.port,
    id: node.id,
    priority: node.priority
  }))
  // adding the leader connected to.
  result.push({ partitions: [], hostname: leaderConnected.split(':')[0], port: leaderConnected.split(':')[1] })
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(result, null, 2))
})
app.get('/partitions', (req, res) => {
  log.info('Partitions request received')
  res.send(partitions())
})

/**
 * Start an express server to monitor the cluster.
 */
const startMonitoring = () => {
  monitor = app.listen(monitoringPort)
  monitor.on('connection', socket => {
    clientSockets.add(socket);
    socket.on("close", () => {
      clientSockets.delete(socket);
    });
  });

  log.info(`Server is monitorable at the port ${monitoringPort}`)
}

function destroySockets(sockets) {
  for (const socket of sockets.values()) {
    socket.destroy();
  }
}

module.exports = {
  start: start,
  defaultPartitioner: require('./partitioner').defaultPartitioner,
  ring: ringInfo,
  startMonitoring: startMonitoring,
  partitions: partitions,
  eventListener: eventEmitter,
  sendData: sendData
}
