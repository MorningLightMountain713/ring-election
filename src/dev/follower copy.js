/**
 * Create a distributed ring and partition data.
 */
'use strict'

// --------------------- CONFIG ---------------------
const os = require('os')
var socketconnector = require('./socketconnector.js')
const NTP = require('ntp-time').Client;
const { default: axios } = require('axios');

// for sentinel config file
const tmp = require('tmp')
const fs = require('fs')

const ntpServers = ['time.google.com', 'time.cloudflare.com', 'time.nist.gov']

const CONCENSUS_THRESHOLD = 0.5

// leader stuff
const heart = new Map()
const heartbeatCheck = require('./heartcheck')
const partitioner = require('./partitioner')
const nodeFetcher = require('./nodefetcher')

// const dedent = require('dedent-js');
const hostname = os.hostname()
const log = require('./logger')
const eventEmitter = require('./eventEmitter')
const {
  timeToReconnect,
  monitoringPort,
  timeToBecomeSeed,
  numPartitions,
  redisPort,
  sentinelPort,
  commsPort,
} = require('./config')
const lastPartition = numPartitions - 1
let monitor = null
let leaderConnected
let sentinelServer = null
// --------------------- CONFIG --------------------

// const RedisServer = require('redis-server')
const Redis = require("ioredis")

const util = require('./util');
const net = require('net')
const heartbeat = require('./heartbeat')
const ipFetcher = require('./myip.js')
const Rx = require('@reactivex/rxjs')
const { checkDiff } = require('./util')
const populatePartitions = require('./populatepartitions.js')
const nodeHunter = require('./nodehunterworker.js')

let inboundPeers = new Set() // sockets
let outboundPeers = new Set() // sockets

// --------------------- CONSTANTS ---------------------
const {
  DISCOVER,
  DISCOVER_REPLY,
  CHALLENGE,
  CHALLENGE_REPLY,
  CHALLENGE_ACK,
  LEADER_PROPOSE,
  LEADER_UPGRADE,
  LEADER_ACK,
  NODE_ADDED,
  NODE_REMOVED,
  WELCOME,
  HEART_BEAT,
  RECONNECT,
  BOOTSTRAP,
  MESSAGE_SEPARATOR,
  BECOME_LEADER,
  PARTITIONS_ASSIGNED,
  PARTITIONS_REVOKED,
  PARTITION_CHANGE,
  REMOVE_FLUXNODE,
  ADD_FLUXNODE,
} = require('./constants')
// --------------------- CONSTANTS ---------------------

// --------------------- DS ---------------------
/** Used for reconnection when a seed node die. */
/* Addresses will be an array so that is more simple to exchange it as object during socket communication */
let networkView = {
  priority: null,
  partitions: [],
  partitionSize: Infinity,
  redisConfigured: false,
  redisPriority: null,
  ringId: null,
  fluxNodes: [],
  ip: null,
  coordinates: [],
  startTime: null,
  networkState: "UNKNOWN",
  upPeers: [],
  downPeers: [],
  uncontactedPeers: [],
  state: "OFFLINE",
  master: null,
  masterState: null,
  masterStartTime: null
}

// --------------------- DS ---------------------

// --------------------- CORE ---------------------

const clientSockets = new Set(); // for monitoring

function prepareMessage(msg) {
  return MESSAGE_SEPARATOR + JSON.stringify(msg) + MESSAGE_SEPARATOR
}

function getLowestIp(ips) {
  let sorted = ips.sort((a, b) => {
    const num1 = Number(a.split(".").map((num) => (`000${num}`).slice(-3)).join(""));
    const num2 = Number(b.split(".").map((num) => (`000${num}`).slice(-3)).join(""));
    return num1 - num2;
  });
  return sorted[0];
}

async function getTime() {
  let server = ntpServers.pop()
  ntpServers.unshift(server)
  let time
  let client = new NTP(server, 123, { timeout: 5000 });
  try {
    let ntpPacket = await client.syncTime()
    time = ntpPacket.time
  } catch (err) {
    return await getTime()
  }
  return time
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const generateID = () => {
  return Math.random()
    .toString(36)
    .substring(7)
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

function makeChallenge(length) {
  var result = '';
  var characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() *
      charactersLength));
  }
  return result;
}

let buff = ""
function decodeMessages(data) {
  let stringData = data.toString()

  if (!buff && !stringData.startsWith(MESSAGE_SEPARATOR)) {
    console.log("Received a non standard message... discarding")
    return null
  }

  if (!stringData.endsWith(MESSAGE_SEPARATOR)) {
    buff += stringData
    return null
  }

  if (buff) {
    stringData = buff + stringData
    buff = ""
  }
  let messages = stringData.split(MESSAGE_SEPARATOR)
  messages = messages.filter(m => m); // strip empty strings
  // need to error check this
  messages = messages.map(m => { return JSON.parse(m) })
  return messages
}

async function newPeerHandler(data, peerSocket, response = null) {
  let messages = decodeMessages(data)
  // what is the context??? Are we the calling socket or the caller? Does it matter?

  if (!messages) {
    return // waiting on buffer
  }

  for (let msg of messages) {
    console.log(msg)
    // const remoteNetworkView = msg.state
    if (msg.type === CHALLENGE_REPLY) {
      if (msg.data === response) {
        peerSocket.write(prepareMessage({ type: CHALLENGE_ACK }))
      }
    } else if (msg.type === DISCOVER) {
      // discover is only sent by a ring member making an outbound connection
      // so we are the server
      const remoteNetworkView = msg.state
      // what about down peers???
      const remotePeers = new Set(remoteNetworkView.upPeers)
      const myPeers = new Set(networkView.upPeers)

      const peerIndex = networkView.upPeers.findIndex(p => {
        return p.ip === remoteNetworkView.ip
      })

      if (peerIndex > -1) {
        networkView.upPeers[peerIndex].networkView = remoteNetworkView
      } else { // haven't seen this peer yet... maybe they're a down peer?
        console.log("peer address")
        console.log(peerSocket.address())
        networkView.upPeers.push({ ip: remoteNetworkView.ip, port: commsPort, networkView: remoteNetworkView })
      }

      // this just means the objects are different. We might still have one, but
      // just in a different state
      let newPeersForUs = [...remotePeers].filter(x => !myPeers.has(x))
      // add these to unconfirmed peers

      // UPDATE OUR STATE FIRST THEN SEND IT BACK

      peerSocket.write(prepareMessage({ type: DISCOVER_REPLY, state: networkView }))
      // work out the difference in peers, then if remote has new peers, we connect to them,
      // and vice versa, if they are missing - we give them up.

      // check if they have a master and what state the master is in. Depends what our
      // state is, if we are following... we don't need a new master

      // check what their start time is, this is only relevant if we don't have a leader

      // get their coordinates and work out how far away they are

      // add them as a provisional peer???? so we can keep their state
    } else if (msg.type === DISCOVER_REPLY) {


      const ourMaster = networkView.master
      const ourMasterState = networkView.masterState
      const remoteNetworkView = msg.state

      const peerIndex = networkView.upPeers.findIndex(p => {
        return p.ip === remoteNetworkView.ip
      })

      if (peerIndex > -1) {
        networkView.upPeers[peerIndex].networkView = remoteNetworkView
      }


      // this might be our first reply of many...

      // now we compare current network view to new network view
      // do they have a full master? is it this node? - if so send BOOTSTRAP, else
      // check peers to see if we have a connection
      if (remoteNetworkView.master) {
        if (remoteNetworkView.masterState === "FULL") {
          networkView.master = remoteNetworkView.master
          networkView.masterState = "FULL"
          if (remoteNetworkView.master === peerSocket.remoteAddress) {
            peerSocket.write(prepareMessage({ type: BOOTSTRAP, state: networkView }))
          }
          else { // someone else is master
            // go lookup ip address in peers and connect to master. It might not be
            // in our list?? maybe
            // need some way to check for peers that are "IN_PROGRESS" or something
            // so we only connect once.
            let masterSocket = inboundPeers.forEach((p) => {
              if (p.remoteAddress === remoteNetworkView.master) {
                return p
              }
            })
            if (masterSocket) {
              masterSocket.write(prepareMessage({ type: BOOTSTRAP, state: networkView }))
            }
            else {
              // we need to connect to new master. Bit weird, should be in our list
              masterSocket = await socketconnector(`${remoteNetworkView.master}:${commsPort}`)
              networkView.upPeers.push({ ip: masterSocket.remoteAddress, masterSocket: peer.remotePort })
              masterSocket.write(prepareMessage({ type: BOOTSTRAP, state: networkView }))
            }
          }

        } else if (remoteNetworkView.masterState === "PROVISIONAL") {
          if (ourMaster && ourMasterState === "FULL") {
            // send stand down and send our state
          } else if (ourMaster && ourMasterState === "PROVISIONAL") {
            // compare start times, MASTER_NAK the youngest, MASTER_ACK the older
          } else { // we take the provisional master
            networkView.master = remoteNetworkView.master
            networkView.masterState = "PROVISIONAL"
            if (remoteNetworkView.master === peerSocket.remoteAddress) {
              peerSocket.write(prepareMessage({ type: LEADER_ACK, state: networkView }))
            }
            else { // someone else is master
              // go lookup ip address in peers and connect to master. It might not be
              // in our list?? maybe
              // need some way to check for peers that are "IN_PROGRESS" or something
              // so we only connect once.
              let masterSocket = inboundPeers.forEach((p) => {
                if (p.remoteAddress === remoteNetworkView.master) {
                  return p
                }
              })
              // shoudl this also be outbound peers?
              if (masterSocket) {
                masterSocket.write(prepareMessage({ type: LEADER_ACK, state: networkView }))
              }
              else {
                // we need to connect to new master. Bit weird, should be in our list
                masterSocket = await socketconnector(`${remoteNetworkView.master}:${commsPort}`)
                networkView.upPeers.push({ ip: masterSocket.remoteAddress, masterSocket: peer.remotePort })
                masterSocket.write(prepareMessage({ type: LEADER_ACK, state: networkView }))
              }
            }
          }
        }
      }
      // no remote master
      if (networkView.master) {
        // send MASTER_UPDATE with our state
      }

      // we just have each other as a peer, and we started at the same time. Find
      // out who has the lowest start time, they are the leader
      if (remoteNetworkView.upPeers.length === 1 && networkView.upPeers.length === 1) {
        if (networkView.startTime < remoteNetworkView.startTime) {
          networkView.state = "PROVISIONAL_LEADER"
          // can validate this message on the other side
          peerSocket.write(prepareMessage({ type: LEADER_PROPOSE, state: networkView }))
        } else if (networkView.startTime === remoteNetworkView.startTime) {
          // would be pretty freaky for this to happen but okay
          // go to ip address tiebreaker
        } else if (networkView.startTime > remoteNetworkView.startTime) {

          networkView.state = "PROVISIONAL_FOLLOWER"
          networkView.master = {
            ip: peerSocket.remoteAddress, port: peerSocket.remotePort
          }
          peerSocket.write(prepareMessage({ type: LEADER_ACK, state: networkView }))
        }
      }
      // should have a master by here

    } else if (msg.type === LEADER_PROPOSE) {
      let remoteNetworkView = msg.state

      const peerIndex = networkView.upPeers.findIndex(p => {
        return p.ip === remoteNetworkView.ip
      })

      if (peerIndex > -1) {
        networkView.upPeers[peerIndex].networkView = remoteNetworkView
      }

      // check peers start time to validate and set state, send LEADER_ACK
      if (networkView.startTime > remoteNetworkView.startTime) {
        // we concur
        peerSocket.write(prepareMessage({ type: LEADER_ACK, state: networkView }))
      } else {
        // we should never get here
      }

    } else if (msg.type === LEADER_ACK) {
      // check how many peers have us as the leader, if it's more than 60%, change
      // state to full leader and broadcast a LEADER_UPGRADE

      // THIS DEPENDS IF WE ARE PROVISIONAL - OR WE'RE FULL
      // should split them out PROVISIONAL_LEADER_ACK FULL_LEADER_ACK, just have a param
      // full: true / falwse

      let remoteNetworkView = msg.state

      const peerIndex = networkView.upPeers.findIndex(p => {
        return p.ip === remoteNetworkView.ip
      })

      if (peerIndex > -1) {
        networkView.upPeers[peerIndex].networkView = remoteNetworkView
      }

      // add / update any peers
      let peerConfirms = 0
      networkView.upPeers.map(peer => {
        // need to set the peer view under peers
        if (peer.networkView.master === networkView.ip) {
          peerConfirms++
        }
      })

      console.log(`Peer confirms: ${peerConfirms}`)

      // this means we need 2 out of 3
      // just doing 50% for testing with 2 nodes
      if ((peerConfirms / networkView.upPeers.length) >= CONCENSUS_THRESHOLD) {
        console.log("Broadcasting leader upgrade")
        networkView.state = "LEADER"
        networkView.masterState = "FULL"
        // initiate leader stuff - nodehunter, this should be done here as a full leader
        // but we've done it in provisional - should change
        util.broadcastMessage(inboundPeers, { type: LEADER_UPGRADE, state: networkView })

      } else {
        networkView.state = "PROVISIONAL_LEADER"
        // we just chilling to 60%
      }
    }
    else if (msg.type === LEADER_UPGRADE) {
      let remoteNetworkView = msg.state
      // means the remote end has confirmed themseles as leader (over 60% confirms)
      // we fall into line

      // need to check our network view, if the leader doesn't match this one... we
      // need to notify the other leader to stand down

      // do other stuff

      networkView.master = remoteNetworkView.master
      networkView.masterState = "FULL"

      peerSocket.write(prepareMessage({ type: BOOTSTRAP, state: networkView }))


    }
    ///////////// NORMAL MESSAGES FROM HERE

    else if (msg.type === WELCOME) { // this is only from LEADER
      // welcome needs to be seperated from the starting of the work (fluxnode monitoring)
      // that way the leader can control and differentiate between a follower firing up
      // and when they start actually working
      // convert array in a map.
      // this could compare to our networkState
      // remoteNetworkState = jsonData.msg
      // find ourselves in peer state
      let remoteNeworkView = msg.state
      let me = remoteNeworkView.upPeers.find(p => {
        return p.ip === networkView.ip
      })
      // do some comparisions, connect to any peers that we don't have already
      networkView.id = me.id
      networkView.priority = me.priority
      networkView.redisPriority = me.redisPriority
      networkView.partitions = me.partitions
      // the above is all wrong - it will be in the state

      log.info(`Id in the ring ${networkView.id} ,priority in the ring ${networkView.priority}, redis priority in the ring ${networkView.redisPriority}`)
      log.info(`Assigned partitions: ${networkView.partitions} `)
      heartbeat(peerSocket, networkView.id)
      eventEmitter.emit(PARTITIONS_ASSIGNED, networkView.partitions)

      if (!networkView.redisConfigured) {
        networkView.redisConfigured = true
        let redis = await getRedisConnection("flux_cerebro_redisjson")
        const configSet = ["call", "CONFIG", "SET"]

        const priority = [...configSet, "replica-priority", `${networkView.redisPriority} `]
        const replicaOf = ["replicaof", `${networkView.master}} `, `${redisPort} `]
        const replicaAnnounceIp = [...configSet, "replica-announce-ip", `${networkView.ip} `]
        const replicaAnnouncePort = [...configSet, "replica-announce-port", `${redisPort} `]

        const commands = [priority, replicaOf, replicaAnnounceIp, replicaAnnouncePort]

        redis.pipeline(commands).exec((err, results) => {
          if (err) {
            console.log(`Error configuring Redis: ${err} `)
          }
          console.log("Redis replica configured")
          redis.disconnect()
          redis.quit()
        })

        let sentinel = await getRedisConnection("flux_cerebro_sentinel", 26379)

        const callSentinel = ["call", "sentinel"]
        const SentinelconfigSet = [...callSentinel, "CONFIG", "SET"]

        const monitorLeader = [...callSentinel, "monitor", "LEADER", `${networkView.master} `, `${redisPort} `, 2]
        const announcePort = [...SentinelconfigSet, "announce-port", `${sentinelPort} `]
        const announceIp = [...SentinelconfigSet, "announce-ip", `${networkView.ip} `]
        const downAfter = [...callSentinel, "SET", "LEADER", "down-after-milliseconds", 5000]
        const failOver = [...callSentinel, "SET", "LEADER", "failover-timeout", 15000]
        const parallelSyncs = [...callSentinel, "SET", "LEADER", "parallel-syncs", 1]

        const sentinelCommands = [monitorLeader, announceIp, announcePort, downAfter, failOver, parallelSyncs]

        sentinel.pipeline(sentinelCommands).exec((err, results) => {
          if (err) {
            console.log(`Error configuring Redis: ${err} `)
          }
          console.log("Sentinel configured")
          sentinel.disconnect()
          sentinel.quit()
          let sentinelIps = networkView.upPeers.map((p => p.ip))
          console.log(`Sentinel Ips: ${sentinelIps}`)
          nodeHunter.start(sentinelIps, [], networkView.coordinates) // start workers with nothing to monitor
          // console.log(results)

        })
      }

    }
    // these next 2 should be merged into one action (verb) with a parameter on msg
    // or probably better yet, just split of the common stuff into a function 
    else if (msg.type === NODE_ADDED) {
      log.info('New node added in the cluster')
      const oldPartitions = []
      Object.assign(oldPartitions, networkView.partitions)
      let remoteNetworkView = msg.state
      let me = remoteNetworkView.upPeers.find((p) => {
        return p.ip === networkView.ip
      })
      // find the node, add it / connect to it if needed
      networkView.partitions = me.partitions

      // this doesn't really do anything
      updatePartitionAssigned(oldPartitions)

    } else if (msg.type === NODE_REMOVED) {
      const removedPriority = msg.removedPriority
      if (networkView.priority > removedPriority) priority--
      log.info(
        `A node was removed from the cluster, now my priority is ${networkView.priority} `
      )
      const oldPartitions = []
      Object.assign(oldPartitions, networkView.partitions)
      let me = msg.state.upPeers.filter((p) => {
        return p.ip === networkView.ip
      })
      // find the node, remove it / delete socket
      networkView.partitions = me.partitions
      updatePartitionAssigned(oldPartitions)
    }
    // this could use a rename, maybe MONITOR_UPDATE
    // need to move non node comms to messaging (different port etc)
    // this is the internal comms bus that we've hijacked
    else if (msg.type === PARTITION_CHANGE) {
      console.log("Received PARTITION_CHANGE message from leader")
      networkView.partitionSize = msg.state.partitionSize
      log.info(`Records per partition has changed to ${networkView.partitionSize}...updating`)
      // do other partition stuff
      networkView.fluxNodes = await populatePartitions(networkView.partitions, networkView.partitionSize)
      // maybe pass in a reason for recalc? does it make a difference. 
      nodeHunter.monitor(networkView.fluxNodes)
      // need to write a function to update nodeHunter sentinel ips for redisio

      // console.log(nodesToMonitor)
    }
    else if (msg.type === ADD_FLUXNODE) {
      // if we have the last partition and its length is shorter than partitionSize
      // add the node - otherwise trigger a reshuffle
      // what happens when we are close to the limit - will get a bunch of reshuffles
      // need like some histerisis or something
      if (networkView.partitions.includes(lastPartition)) {
        let newNodes = msg.nodes
        networkView.fluxNodes.push(...newNodes)
        nodeHunter.addNodes(newNodes)
      }

    }
    else if (msg.type === REMOVE_FLUXNODE) {
      let expiredNodes = msg.nodes
      let nodesToRemove = networkView.fluxNodes.filter((node) => {
        return expiredNodes.includes(node)
      })

      if (nodesToRemove.length > 0) {
        networkView.fluxNodes = networkView.fluxNodes.filter((n) => !nodesToRemove.includes(n));
        nodeHunter.removeNodes(nodesToRemove)
      }
    }
    ////// Leader messages below here
    else if (msg.type === HEART_BEAT) {
      heart.set(msg.id, Date.now())
    } else if (msg.type === BOOTSTRAP) {
      // new host, this is used for the replica-priority. We don't manage it so long as its
      // higher 
      let remoteNetworkView = msg.state
      let clientIp = remoteNetworkView.ip
      let clientRedisPriority = networkView.upPeers.length === 1 ? 0 : Math.max(...networkView.upPeers.map(p => p.redisPriority))

      clientRedisPriority++
      const priority = networkView.upPeers.length


      const cliendId = generateID()
      const assignedPartitions = partitioner.assignPartitions(clientIp, networkView)
      heart.set(cliendId, Date.now())
      // let peer = networkView.upPeers.filter(p => {
      //   return p.ip === peerSocket.remoteAddress
      // })
      let peerIndex = networkView.upPeers.findIndex((obj => obj.ip === clientIp));

      let newData = {
        id: cliendId,
        partitions: assignedPartitions,
        priority: priority,
        redisPriority: clientRedisPriority,
      }

      console.log("Assigned partitions: ", assignedPartitions)

      networkView.upPeers[peerIndex] = { ...networkView.upPeers[peerIndex], ...newData }

      // just checking the above
      console.log(networkView)

      peerSocket.write(prepareMessage({ type: WELCOME, state: networkView }))

      let otherPeers = [...inboundPeers].filter(socket => { return socket !== peerSocket })
      otherPeers = new Set(otherPeers)
      if (otherPeers.size > 0) {
        util.broadcastMessage(otherPeers, { type: NODE_ADDED, state: networkView })
      }
    }
    // ToDo - sort this out
    // else if (type === RECONNECT) {
    //   reconnectClient(client, msg)
    // }
  }
}
function connectionHandler(peerSocket) {
  // this should contain all startup related messaging. This will remain open the life
  // time of the follower. If they get upgraded to leader, the socket stays open, clients
  // connected remain connected but the socket listeners get swapped out
  inboundPeers.add(peerSocket) // we need to pass these to leader will merge
  const challenge = makeChallenge(12)
  // swap this out lol - no point at the moment, need flux vault or something
  const response = challenge.split("").reverse().join("")
  peerSocket.write(MESSAGE_SEPARATOR + JSON.stringify({ type: CHALLENGE, data: challenge }) + MESSAGE_SEPARATOR)
  // merge leader and follower
  peerSocket.setNoDelay(true)
  log.info(`New Client connected host ${JSON.stringify(peerSocket.address())}`)
  const peerHandler = data => { newPeerHandler(data, peerSocket, response) }
  peerSocket.on('data', peerHandler)
}

async function start(seedNodes) {
  // this is ntp time
  networkView.startTime = await getTime()

  const server = net.createServer(connectionHandler)

  server.listen(3000, '0.0.0.0', function () {
    log.info('Cerebro is listening...')

  })

  networkView.ip = await ipFetcher()
  console.log(`Hosts' external ip is: ${networkView.ip}`)

  // get our data here so we can get our lat / long to calculate distance to nodes.
  // Then if nodes take too long, we can offer them out for adoption for someone who is
  // closer. (Maybe swap)

  let peers = new Set()
  let me
  for (const peer of seedNodes.values()) {
    if (peer.ip === networkView.ip) {
      me = peer
    } else {
      peers.add(peer)
    }
  }

  // if seed nodes are passed in, depends if we were passed in (we should have been)
  // probably need to do a bit more work here
  if (me) {
    let res
    const myApiServer = `${me.ip}:${me.apiPort}`
    // fix this up
    try {
      res = await axios.get(`http://${myApiServer}/flux/info`, { timeout: 3000 })
    }
    catch (err) {
      // timeout
    }
    if (res) { // undefined if timeout
      const lat = res.data.data.geolocation?.lat || null
      const lon = res.data.data.geolocation?.lon || null
      networkView.coordinates = [lat, lon]
      console.log("our coordinates")
      console.log(networkView.coordinates)
    }
  }

  const promises = []
  for (let peer of peers.values()) {
    // maybe just use this for connection only, connector does a little validation to
    // prove that we are a peer, like each a string or something, but shouldn't need
    // data cb. Just pass off established peer
    promises.push(socketconnector(`${peer.ip}:${commsPort}`))
  }
  // could delete peers here

  let sockets
  try {
    // this will resolve quickly if all sockets connect or after a max of 3.5s
    sockets = await Promise.all(promises)
  }
  catch (err) {
    console.log(err) // what are these errors?
  }

  for (let socket of sockets) {
    if (socket instanceof Error) {
      networkView.downPeers.push(socket.downPeer)
    } else {
      console.log(socket.readyState)
      if (socket.readyState === "open") {
        networkView.upPeers.push({ ip: socket.remoteAddress, port: socket.remotePort })
        outboundPeers.add(socket)
      }
      else {
        networkView.downPeers.push({ ip: socket.remoteAddress, port: socket.remotePort })
      }
    }
  }

  // if no peers we move straight to start as leader. Should be like unconfirmed leader
  // or something. This means you could have two unconfirmed fight it out, this could
  // happen if peers connect to each other first in seperated networks for whatever reason
  // pretty edge case

  // then once consensus is reached for contatactable nodes peer can confirm them as leader
  // takes 70%? of seed nodes to confirm as leader (that's when you move from unconfirmed
  // leader to full noise leader)

  // unconfirmed leader can't program the db / sentinel - would have to undo if staying
  // as follower. 

  if (outboundPeers.size === 0) {
    // this start leader in unconfirmed mode ( will do )
    startAsLeader(server, inboundPeers, networkView.redisConfigured, networkView.ip, null, 0)
    return
  }

  // add all the peers before we talk to anyone, so we are transmitting our full list

  networkView.state = "discovering"
  // these should all be live peers
  for (const peer of outboundPeers) {
    // we need to add listeners here
    const peerHandler = data => { newPeerHandler(data, peer) }
    peer.on('data', peerHandler)
    peer.write(prepareMessage({ type: DISCOVER, state: networkView }))
  }

  // END HERE - we won't have received any responses. Has to happen in callbacks

  // now we compare current network view to new network view
  // do we have a master?

  // if yes - connect
  // if provisional? // connect and confirm
  // 2 provisionals?
  // if 2 - confirm the lowest and nak the other


  // Think if there was only 2 nodes
  // who has the lowest start time, they are the provisional leader.
  // that node sets state to "provisional leader"
  // send provisional leader a message acknowledging them as PROVISIONAL_LEADER

  // this may only be 2 nodes on the seed nodes list
  // once provisional get to 60% of nodes confirming them - they move to full master



  /////// ------------------- \\\\\\\\
  ///////  -----------------   \\\\\\\\

  // be good if "start" handed off to another function once it's been figured out who
  // the leader is, either startAsLeader or mainLoop (basically just adding listeners)
  ////////

  // if (server) {
  //   // don't shut the server anymore
  //   console.log("Closing server...")
  //   destroySockets(inboundPeers)
  //   server.close(() => {
  //     client.setNoDelay(true)
  //     client.on('end', e => seedEndEvent(client, e))
  //     client.on('error', e => seedErrorEvent(client, e))
  //     client.on('data', data => peerMessageHandler(data, client))

  //     // why not just do leaderIp, leaderPort????
  //     leaderConnected = `${client.remoteAddress}: ${client.remotePort}`

  //     log.info(`connected to server! Leader node is ${leaderConnected}`)
  //     if (id) { // we've already connected to a master before
  //       client.write(MESSAGE_SEPARATOR + JSON.stringify({ type: RECONNECT, msg: { id: id, priority: priority - 1, hostname: hostname, redisPriority: redisPriority } }) + MESSAGE_SEPARATOR)
  //     }
  //     else { // first time, use something better than the hostname, it's garbage. use ipaddress
  //       client.write(MESSAGE_SEPARATOR + JSON.stringify({ type: BOOTSTRAP, msg: hostname }) + MESSAGE_SEPARATOR)
  //     }
  //   })
  // }

  // return client
}

const startAsLeader = async (server, inboundPeers, isRedisConfigured, myIp, sentinel, priorNodeCount) => {
  log.info('Prepping to start as leader...')
  networkView.state = "PROVISIONAL_LEADER"
  networkView.master = networkView.ip
  networkView.masterState = "PROVISIONAL"
  networkView.masterStartTime = networkView.startTime
  // stop redis sentinel so leader can start it again (with correct ip / port)
  // if (monitor) {
  //   destroySockets(clientSockets) // otherwise it hangs for ages
  //   monitor.close(async () => {
  //     log.info('Closing monitoring server started previously')
  //     const leader = require('./leader')
  //     await leader.createServer(server, inboundPeers, isRedisConfigured, myIp, sentinel, priorNodeCount) // redisConfigured = true
  //     leader.startMonitoring()
  //     eventEmitter.emit(BECOME_LEADER)
  //   })
  // } else {
  // const leader = require('./leader')
  // await leader.createServer(server, inboundPeers, isRedisConfigured, myIp, sentinel, priorNodeCount) // redisConfigured = true
  // leader.startMonitoring()
  // eventEmitter.emit(BECOME_LEADER)
  // }
  if (!networkView.redisConfigured) { // we're the OG leader
    networkView.redisConfigured = true

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
      heartbeatCheck(heart, networkView.upPeers)
      nodeFetcher([...inboundPeers], priorNodeCount)
      console.log(networkView)
    })
  }
  // let connectionListener = client => {
  //   client.setNoDelay(true)
  //   log.info(`New Client connected (leader connection event) host ${JSON.stringify(client.address())}`)
  //   // client termination handling.
  //   client.on('end', () => clientDisconnected(client))
  //   client.on('error', e => log.error(`client error ${e}`))
  //   // data received.
  //   client.on('data', data => peerMessageHandler(data, client))
  //   // put client connection in the map , and assign partitions.
  // }


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

// const peerMessageHandler = (data, client) => {
//   let messages = decodeMessages(data)

//   // this isn't necessary but more explicit. If there aren't any messages, we may be
//   // waiting for another data packet
//   if (!messages) {
//     return
//   }

//   messages.forEach(async e => {
//     // message seperator split returns empty for the seperator
//     if (e.length <= 0) return
//     // ToDo: try / catch
//     const jsonData = JSON.parse(e)
//     const type = jsonData.type
//     const msg = jsonData.msg
//     log.debug(`Receveid a message with type ${type} `)
//     if (type === WELCOME) { // this is only from LEADER?
//       // welcome needs to be seperated from the starting of the work (fluxnode monitoring)
//       // that way the leader can control and differentiate between a follower firing up
//       // and when they start actually working
//       seedNodesTried = 0
//       // convert array in a map.
//       // this could compare to our networkState
//       // remoteNetworkState = jsonData.msg
//       addresses = jsonData.msg
//       id = jsonData.id
//       priority = jsonData.priority
//       redisPriority = jsonData.redisPriority
//       log.info(`Id in the ring ${id} , priority in the ring ${priority}, redis priority in the ring ${redisPriority} `)
//       log.info(`Assigned partitions: ${jsonData.partitions} `)
//       assignedPartitions = jsonData.partitions
//       heartbeat(client, id)
//       eventEmitter.emit(PARTITIONS_ASSIGNED, assignedPartitions)

//       if (!redisConfigured) {
//         redisConfigured = true
//         let redis = await getRedisConnection("flux_cerebro_redisjson")
//         const configSet = ["call", "CONFIG", "SET"]

//         const priority = [...configSet, "replica-priority", `${redisPriority} `]
//         const replicaOf = ["replicaof", `${leaderConnected.split(':')[0]} `, `${redisPort} `]
//         const replicaAnnounceIp = [...configSet, "replica-announce-ip", `${networkView.ip} `]
//         const replicaAnnouncePort = [...configSet, "replica-announce-port", `${redisPort} `]

//         const commands = [priority, replicaOf, replicaAnnounceIp, replicaAnnouncePort]

//         redis.pipeline(commands).exec((err, results) => {
//           if (err) {
//             console.log(`Error configuring Redis: ${err} `)
//           }
//           console.log("Redis replica configured")
//           redis.disconnect()
//         })
//         redis.quit()

//         let sentinel = await getRedisConnection("flux_cerebro_sentinel", 26379)

//         const callSentinel = ["call", "sentinel"]
//         const SentinelconfigSet = [...callSentinel, "CONFIG", "SET"]

//         const monitorLeader = [...callSentinel, "monitor", "LEADER", `${leaderConnected.split(':')[0]} `, `${redisPort} `, 2]
//         const announcePort = [...SentinelconfigSet, "announce-port", `${sentinelPort} `]
//         const announceIp = [...SentinelconfigSet, "announce-ip", `${networkView.ip} `]
//         const downAfter = [...callSentinel, "SET", "LEADER", "down-after-milliseconds", 5000]
//         const failOver = [...callSentinel, "SET", "LEADER", "failover-timeout", 15000]
//         const parallelSyncs = [...callSentinel, "SET", "LEADER", "parallel-syncs", 1]

//         const sentinelCommands = [monitorLeader, announceIp, announcePort, downAfter, failOver, parallelSyncs]

//         sentinel.pipeline(sentinelCommands).exec((err, results) => {
//           if (err) {
//             console.log(`Error configuring Redis: ${err} `)
//           }
//           console.log("Sentinel configured")
//           // console.log(results)
//           sentinel.disconnect()
//         })
//       }

//       let sentinelIps = networkView.peers.map((p => { p.ip }))

//       nodeHunter.start(sentinelIps, [], ourCoordinates) // start workers with nothing to monitor

//     }
//     // these next 2 should be merged into one action (verb) with a parameter on msg
//     // or probably better yet, just split of the common stuff into a function 
//     else if (type === NODE_ADDED) {
//       log.info('New node added in the cluster')
//       const oldPartitions = []
//       Object.assign(oldPartitions, assignedPartitions)
//       // just give us the node and we will add it - then confirm with the node??
//       addresses = msg
//       updatePartitionAssigned(oldPartitions)
//     } else if (type === NODE_REMOVED) {
//       const removedPriority = jsonData.removedPriority
//       if (priority > removedPriority) priority--
//       log.info(
//         `A node was removed from the cluster, now my priority is ${priority} `
//       )
//       const oldPartitions = []
//       Object.assign(oldPartitions, assignedPartitions)
//       // same as above, just let us remove from our state
//       addresses = msg
//       updatePartitionAssigned(oldPartitions)
//       // make the stuff below a function, as we need to call it here
//     }
//     // this could use a rename, maybe MONITOR_UPDATE
//     // need to move non node comms to messaging (different port etc)
//     // this is the internal comms bus that we've hijacked
//     else if (type === PARTITION_CHANGE) {
//       console.log("Received PARTITION_CHANGE message from leader")
//       // nodeHunter.stop() // this is brutal
//       partitionSize = msg.partitionSize
//       log.info(`Records per partition has changed to ${partitionSize}...updating`)
//       // do other partition stuff
//       nodesToMonitor = await populatePartitions(assignedPartitions, partitionSize)
//       // maybe pass in a reason for recalc? does it make a difference. 
//       nodeHunter.monitor(nodesToMonitor)
//       // need to write a function to update nodeHunter sentinel ips for redisio

//       // console.log(nodesToMonitor)
//     }
//     else if (type === ADD_FLUXNODE) {
//       // this seems to be triggering every time
//       if (assignedPartitions.includes(lastPartition)) {
//         let newNodes = msg.nodes
//         nodeHunter.addNodes(newNodes)
//       }
//       // if we have the last partition and its length is shorter than partitionSize
//       // add the node - otherwise trigger a reshuffle
//       // what happens when we are close to the limit - will get a bunch of reshuffles
//       // need like some histerisis or something
//     }
//     else if (type === REMOVE_FLUXNODE) {
//       let expiredNodes = msg.nodes
//       let nodesToRemove = nodesToMonitor.filter((node) => {
//         return expiredNodes.includes(node)
//       })
//       if (nodesToRemove.length > 0) {
//         nodeHunter.removeNodes(nodesToRemove)
//       }
//     }
//     // handle all types of messages.
//   })
// }

/**
 * Update the partitions assigned to this node.
 * Calculate the diff between old assigned partitions and new and emit the diff.
 * @param {*Array} oldPartitions
 */
const updatePartitionAssigned = (oldPartitions) => {
  // this is just updating our state, it's all good, maybe just get rid of this rx stuff.
  // easy enough to serialize an object for json
  // Rx.Observable.from(addresses)
  //   .find(a => a.id === id)
  //   .subscribe(e => {
  //     assignedPartitions = e.partitions
  //   })
  const assignedPartitions = networkView.partitions

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
  // need to try reconnecting to original seed, then move on, this needs work

  // this whole function is stupid, we go through loops finding out the new master,
  // then just cycle through them anyway
  log.error('Seed node is dead')
  // just dig into the state object a bit to get this
  if (addresses.length === 0) {
    // I've just added this in there so we don't error on the e.hostname below
    // means we connected, but the connection was dropped. (socat)
    log.info("Received a TCP RST from neighbor (SOCAT)... moving on")
    // setTimeout(start, timeToReconnect, seedNodes)
    return
  }
  // update this, can make it much simplier
  Rx.Observable.from(addresses)
    .find(e => e.priority === 1)
    .subscribe(
      e => {
        log.info(`Find vice seed node with address ${e.hostname} `)
        // setTimeout(start, timeToReconnect, seedNodes)
      },
      error => log.error(error),
      () => log.info('Will reconnect to seed node')
    )
}

/**
 * Handler for seed node disconnection.
 */
const seedEndEvent = (client, err) => {
  if (err) log.error(`Seed error event: ${err} `)
  log.info('seed node disconnected')
  client.end()
  client.destroy()
  // keep clients updated
  if (priority === 1) {
    log.info(
      'Becoming seed node , clearing server list and waiting for connections'
    )
    assignedPartitions = []
    nodeHunter.stop()
    // ridik
    setTimeout(startAsLeader, timeToBecomeSeed, null, null, networkView.redisConfigured, networkView.ip, sentinelServer, addresses.length - 1)
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
  // do things here
  // start(seedNodes)
}

// --------------------- MESSAGING ---------------------
/**
 * @returns all the ring info , including leader
 */
const ringInfo = () => {
  return networkState
}
/**
 * @returns the assigned partitions for this follower
 */
const partitions = () => {
  return assignedPartitions
}

// --------------------- MONITORING ---------------------
const express = require('express')
const cors = require('cors');
const { removeListener } = require('process');
// const util = require('./util');

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

  log.info(`Server is monitorable at the port ${monitoringPort} `)
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
