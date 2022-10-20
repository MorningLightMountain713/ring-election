/**
 * This component will check periodically if some node is not sending
 nodes from the ring.
 */
'use strict'
const log = require('./logger')
const Rx = require('@reactivex/rxjs')
/** max time to wait for an heartbeat(in ms) */
const { maxInactiveTime, heartbeatCheckFrequency } = require('./config')
const partitioner = require('./partitioner')
const util = require('./util')
const { NODE_REMOVED } = require('./constants')
// --------------------- HEART ---------------------
/**
 * Check if some node is dead.
 */
const heartbeatCheckLogic = function (heartBeats, sockets, networkView) {
  if (heartBeats.size <= 0) {
    log.debug('No other nodes in the ring')
    return
  }
  log.debug('Doing a heart check')
  for (const [id, lastUpdate] of heartBeats) {
    if (Date.now() - lastUpdate > maxInactiveTime) {
      console.log("Node timed out...")
      console.log(id, lastUpdate)
      removeNode(id, heartBeats, sockets, networkView)
    }
  }
}
/**
 * Start a periodic check to see if any node should be removed from the cluster.
 * @param {Map} heartBeats
 * @param {Array} sockets
 */
const heartbeatCheck = function (heartBeats, sockets, networkView) {
  setInterval(
    () => heartbeatCheckLogic(heartBeats, sockets, networkView),
    heartbeatCheckFrequency
  )
}

/**
 * Remove nodes from data structures.
 * @param {map entry} entry
 */
const removeNode = (id, heartBeats, sockets, networkView) => {
  console.log('Removing a node')
  // time expired

  heartBeats.delete(id)
  const peerIndex = networkView.upPeers.findIndex(p => { return p.id === id })
  console.log(`Dead peer index: ${peerIndex}`)

  // fix this
  let deadSockets = []
  for (let socket of sockets) {
    if (socket.readyState !== "open") {
      console.log(socket.id)
      console.log(socket.ip)
      console.log("Found dead socket")
      deadSockets.push(socket)
    }
  }

  for (let socket of deadSockets) {
    sockets.delete(socket)
  }

  const peerPriority = networkView.upPeers[peerIndex].priority
  console.log("Peer index: ", peerIndex)
  const peer = networkView.upPeers[peerIndex]

  console.log(peer)

  networkView.upPeers.splice(peerIndex, 1)
  networkView.downPeers.push(peer)

  networkView.upPeers.forEach(p => {
    if (p.priority > peerPriority) {
      p.priority--
    }
  })

  partitioner.rebalancePartitions(networkView)

  util.broadcastMessage(sockets, { type: NODE_REMOVED, id: id, state: networkView })
}

module.exports = heartbeatCheck
