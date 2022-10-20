'use strict'

const { inspect } = require('util')

const NTP = require('ntp-time').Client;
const { default: axios } = require('axios');

const socketconnector = require('./socketconnector.js')
const handlers = require('./messageHandlers.js')

const heart = new Map()
const heartbeatCheck = require('./heartcheck')


const log = require('./logger')
// const eventEmitter = require('./eventEmitter')

const {
  monitoringPort,
  commsPort,
} = require('./config')

// --------------------- CONFIG --------------------

const { generateId, prepareMessage } = require('./util');

const ntpServers = ['time.google.com', 'time.cloudflare.com', 'time.nist.gov']
const net = require('net')
const ipFetcher = require('./myip.js')

const sockets = new Set()
const monitorSockets = new Set()
let becomeLeader = false

// --------------------- CONSTANTS ---------------------
const {
  DISCOVER,
  DISCOVER_REPLY,
  CHALLENGE,
  CHALLENGE_REPLY,
  LEADER_PROPOSE,
  LEADER_UPGRADE,
  LEADER_ACK,
  LEADER_NAK,
  NODE_ADDED,
  NODE_REMOVED,
  WELCOME,
  WELCOME_ACK,
  HEART_BEAT,
  RECONNECT,
  BOOTSTRAP,
  MESSAGE_SEPARATOR,
  BEGIN_WORK,
  REMOVE_FLUXNODE,
  ADD_FLUXNODE,
  SANITY_CHECK,
  SANITY_CHECK_REPLY,
  GOSSIP,
} = require('./constants')
// --------------------- CONSTANTS ---------------------

// --------------------- STATE ---------------------
let networkView = {
  id: null,
  priority: null,
  partitions: [],
  partitionSize: Infinity,
  redisConfigured: false,
  redisPriority: null,
  fluxNodes: [],
  ip: null,
  port: null,
  apiPort: null,
  coordinates: [],
  startTime: null,
  networkState: "UNKNOWN",
  upPeers: [],
  downPeers: [],
  upreachablePeers: [],
  state: "OFFLINE",
  master: null,
  masterState: null,
  masterStartTime: null,
  socketCount: 0,
  timestamp: 0,
  peerConfirms: 0
}

// --------------------- STATE ---------------------

// --------------------- CORE ---------------------

function resetState() {
  // not sure about the best way to do this
  networkView.id = null
  networkView.priority = null
  networkView.partitions = []
  networkView.partitionSize = Infinity
  networkView.redisConfigured = false
  networkView.redisPriority = null
  networkView.fluxNodes = []
  networkView.ip = null
  networkView.port = null
  networkView.apiPort = null
  networkView.coordinates = []
  networkView.startTime = null
  networkView.networkState = "UNKNOWN"
  networkView.upPeers = []
  networkView.downPeers = []
  networkView.upreachablePeers = []
  networkView.state = "OFFLINE"
  networkView.master = null
  networkView.masterState = null
  networkView.masterStartTime = null
  networkView.socketCount = 0
  networkView.timestamp = 0
  networkView.peerConfirms = 0
}

function getTimestamp() {
  return Date.now()
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

// what about cleaning up old id's from the buffer. When a socket gets destroyed, we need
// to clean up

// converted to map - better than Object here.
let buff = new Map()
function decodeMessages(id, data) {
  // could just set decoding

  let stringData = data.toString()
  // this has more holes than swiss cheese

  // if the id hasn't been created, create it
  !(buff.has(id)) && (buff.set(id, ""))

  // think this makes sense. Shouldn't ever get a message start with a message seperator
  // when there is a buffer, if so - we lost it, so discard. Maybe could seperate the
  // message starter from the finish, yeah, I like it
  if (buff.get(id) && stringData.startsWith(MESSAGE_SEPARATOR)) {
    buff.set(id, "")
  }

  if (buff.get(id) === "" && !stringData.startsWith(MESSAGE_SEPARATOR)) {
    console.log("Received a non standard message... discarding")
    console.log(inspect(stringData, { depth: null }))
    return null
  }

  if (!stringData.endsWith(MESSAGE_SEPARATOR)) {
    buff.set(id, buff.get(id) + stringData)
    return null
  }

  // we should have a full message by now
  if (buff.get(id)) {
    stringData = buff.get(id) + stringData
    buff.set(id, "")
  }
  let messages = stringData.split(MESSAGE_SEPARATOR)
  messages = messages.filter(m => m); // strip empty strings
  // need to error check this
  messages = messages.map(m => { return JSON.parse(m) })
  return messages
}

async function newPeerHandler(data, peerSocket, challengeResponse = null) {
  let messages = decodeMessages(peerSocket.id, data)

  if (!messages) {
    console.log("Waiting on buffer...")
    return
  }

  for (let msg of messages) {
    // console.log(inspect(msg, { depth: null }))
    if (msg.type !== HEART_BEAT) {
      console.log(`Received a ${msg.type} message from ${peerSocket.ip}`)
    }
    switch (msg.type) {
      case CHALLENGE_REPLY:
        handlers.challengeReply(peerSocket, challengeResponse, msg)
        break
      case DISCOVER:
        handlers.discover(peerSocket, networkView, msg)
        break
      case DISCOVER_REPLY:
        handlers.discoverReply(sockets, peerSocket, networkView, msg)
        break
      case BOOTSTRAP:
        handlers.bootstrap(sockets, heart, peerSocket, networkView, msg)
        break
      case RECONNECT:
        handlers.reconnect(sockets, heart, peerSocket, networkView, msg)
        break
      case LEADER_PROPOSE:
        handlers.leaderPropose(sockets, peerSocket, networkView, msg)
        break
      case LEADER_ACK:
        handlers.leaderAck(heart, sockets, peerSocket, networkView, msg)
        break
      case LEADER_NAK:
        handlers.leaderNak(sockets, peerSocket, networkView, msg)
        break
      case LEADER_UPGRADE:
        handlers.leaderUpgrade(peerSocket, networkView, msg)
        break
      case WELCOME:
        handlers.welcome(heart, sockets, peerSocket, networkView, msg)
        break
      case WELCOME_ACK:
        handlers.welcomeAck(sockets, peerSocket.id, networkView, msg)
        break
      case NODE_ADDED:
        handlers.nodeAdded(peerSocket, networkView, msg)
        break
      case NODE_REMOVED:
        handlers.nodeRemoved(sockets, networkView, msg)
        break
      case BEGIN_WORK:
        handlers.beginWork(networkView, msg)
        break
      case ADD_FLUXNODE:
        handlers.addFluxNode(networkView, msg)
        break
      case REMOVE_FLUXNODE:
        handlers.removeFluxNode(networkView, msg)
        break
      case HEART_BEAT:
        handlers.heartBeat(heart, msg)
        break
      case SANITY_CHECK:
        handlers.sanityCheck(networkView, peerSocket)
        break
      case GOSSIP:
        handlers.gossip(sockets, peerSocket.id, networkView, msg)
        break
      default:
        console.log(`Received an unknown message of type: ${msg.type}, ignoring`)
    }
  }
}

async function setCoordinates(me) {
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

function connectionHandler(peerSocket) {
  // these Id's are local to this box
  peerSocket.id = generateId()
  sockets.add(peerSocket)
  networkView.socketCount++
  const challenge = makeChallenge(12)
  // swap this out lol - no point at the moment, need flux vault or something
  const response = challenge.split("").reverse().join("")
  peerSocket.write(prepareMessage({ type: CHALLENGE, ip: networkView.ip, data: challenge }))
  // merge leader and follower
  peerSocket.setNoDelay(true)
  const peerDataHandler = data => { newPeerHandler(data, peerSocket, response) }
  const peerCloseHandler = () => { deadPeerHandler(peerSocket) }
  peerSocket.on('data', peerDataHandler)
  peerSocket.on('close', peerCloseHandler)
}

function deadPeerHandler(peerSocket) {
  buff.delete(peerSocket.id)
  networkView.socketCount--
  sockets.delete(peerSocket)
  peerSocket.unref()
}

async function start(seedNodes) {
  // this is ntp time
  networkView.startTime = await getTime()
  networkView.ip = await ipFetcher()
  console.log(`Hosts' external ip is: ${networkView.ip}`)

  const server = net.createServer(connectionHandler)

  server.listen(3000, '0.0.0.0', function () {
    console.log('Cerebro is listening...')

  })

  // get our data here so we can get our lat / long to calculate distance to nodes.
  // Then if nodes take too long, we can offer them out for adoption for someone who is
  // closer. (Maybe swap)

  const me = seedNodes.find(n => { return n.ip === networkView.ip })
  const peers = seedNodes.filter(n => { return n.ip !== networkView.ip })

  // if seed nodes are passed in, depends if we were passed in (we should have been)
  // probably need to do a bit more work here
  if (me) {
    networkView.apiPort = me.apiPort
    setCoordinates(me)
  }

  const promises = peers.map((peer) => { return socketconnector(peer.ip, commsPort, networkView.ip) })

  // this will resolve quickly if all sockets connect or after a max of 5s
  const outboundSockets = await Promise.all(promises)

  for (let socket of outboundSockets) {
    if (socket instanceof Error) {
      networkView.downPeers.push(socket.downPeer)
    } else {
      console.log(`Socket readyState: ${socket.readyState}`)
      if (socket.readyState === "open") {
        // local to this box only
        socket.id = generateId()
        // probably need to create a new map with ip -> socket.id
        networkView.upPeers.push({ ip: socket.remoteAddress, port: socket.remotePort, timestamp: getTimestamp() })
        sockets.add(socket)
        networkView.socketCount++
        socket.sendDiscover = true
      }
      else {
        networkView.downPeers.push({ ip: socket.remoteAddress, port: socket.remotePort, timestamp: getTimestamp() })
        socket.unref()
      }
    }
  }

  if (!becomeLeader) {
    startMonitoring(seedNodes, server, outboundSockets)
  }

  if (sockets.size === 0 || becomeLeader) {
    becomeLeader = false
    networkView.networkState = "AWAITING_PEERS"
    networkView.state = "PROVISIONAL_LEADER"
    networkView.master = networkView.ip
    networkView.masterState = "PROVISIONAL"
    networkView.masterStartTime = networkView.startTime

    heartbeatCheck(heart, sockets, networkView)
    console.log("Leader awaiting peers...")
    // need to periodically check for seeds. If we're isolated, the network could be
    // running and we wouldn't know. If we make contact and there is another full node,
    // need to check if they have followers, if so we connect to them. If not do a show
    // down

    // disabling this for the meantime, adding too much complexity

    // makeContact(server, peers, seedNodes) // connect to peers every 3 minutes
    return
  }

  //we have to use outbound sockets here otherwise, if someone sneaks in, they can get
  // added in overall sockets and we send 2 discovers
  networkView.state = "DISCOVERING"
  for (const peer of outboundSockets) {
    if (peer.sendDiscover) {
      const peerHandler = data => { newPeerHandler(data, peer) }
      peer.on('data', peerHandler)
      // what about error / end?
      peer.write(prepareMessage({ type: DISCOVER, state: networkView }))
    }
  }
}

async function makeContact(server, peers, seedNodes) {
  // if we have no peers... seems a bit fruity so we reach out
  // periodically to make sure we haven't been isolated. This could happen for the
  // following reasons:

  // 1/ We are the OG leader
  // 2/ As nodes get added to Applocations or whatever, it will take a minute for socat
  // to pick this up. If a node starts and socat isn't forwarding -they will get rejected
  let contactMade = false
  let timer = setInterval(async () => {
    if (sockets.size > 0) {
      clearInterval(timer)
      return
    }
    const promises = peers.map((peer) => { return socketconnector(peer.ip, commsPort, networkView.ip) })
    console.log("Reaching out to peers to make contact...")
    const outboundSockets = await Promise.all(promises)

    for (let socket of outboundSockets) {
      if (socket instanceof Error) {
        continue
      }

      if (socket.readyState === "open") {
        socket.on('data', (data) => {
          if (contactMade) {
            return
          }
          // read info from reply and determine if we need to restart, this
          // will force this node to join.
          let messages = decodeMessages(data)
          for (let msg of messages) {
            if (msg.type === SANITY_CHECK_REPLY) {
              remoteNetworkView = msg.state
              if (remoteNetworkView.master) { // this should be true most of the time
                contactMade = true // we only want the first reply
                clearInterval(timer)
                // this should close clean as we have noone connected to us
                server.close()
                server.unref()
                for (const socket of outboundSockets) {
                  socket.destroy()
                  socket.unref()
                }
                resetState()
                start(seedNodes) // if you can't beat em... join em
                return
              }
            }
          }
        })
        socket.write(prepareMessage({ type: SANITY_CHECK }))
      }
    }
  }, 1000 * 180) // 3 minutes
}

const startMonitoring = (seedNodes, server, outboundSockets) => {
  const express = require('express')
  const cors = require('cors');
  // const { removeListener } = require('process');
  // // const util = require('./util');

  const app = express()
  app.use(cors())
  app.get('/restart', (req, res) => {
    console.log("restarting")
    server.close()
    server.unref()
    for (const socket of outboundSockets) {
      socket.destroy()
      socket.unref()
    }
    resetState()
    start(seedNodes)
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ data: "Restarting" }))
  })
  app.get('/status', (req, res) => {
    console.log('Follower status request received')
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(networkView, null, 2))
  })
  app.get('/becomeleader', (req, res) => {
    becomeLeader = true
    server.close()
    server.unref()
    for (const socket of outboundSockets) {
      socket.destroy()
      socket.unref()
    }
    resetState()
    start(seedNodes)
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ data: "Set leader variable and restarted" }))
  });
  const monitor = app.listen(monitoringPort)
  monitor.on('connection', socket => {
    monitorSockets.add(socket);
    socket.on("close", () => {
      monitorSockets.delete(socket);
    });
  });

  console.log(`Server is monitorable at the port ${monitoringPort} `)
}

// function destroySockets(sockets) {
//   for (const socket of sockets.values()) {
//     socket.destroy();
//   }
// }

module.exports = {
  start: start,
  // startMonitoring: startMonitoring,
}
