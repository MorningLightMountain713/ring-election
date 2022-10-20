/**
 * Default partitioner will partition data in a round robin fashion.
 * This component will rebalance partitions when a node is added or removed from the cluster.
 */
'use strict'
const Rx = require('@reactivex/rxjs')
const log = require('./logger')
const util = require('./util')
const { numPartitions: numberOfPartitions } = require('./config')

const utily = require('util')

/**
 * Default Partitioner is a round robin algorithm
 * @param {*} data  the data to insert.
 */
const defaultPartitioner = data => {
  return Math.abs(hashCode(data) % numberOfPartitions)
}

/**
 *
 * @param {*} s a string or an object
 */
const hashCode = key => {
  var h = 0
  const s = key.toString()
  for (var i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0 }
  return h
}

/**
 * Assign all partitions to one node.
 * @param {*} numOfPartitions
 * @param {*} partitionsAssigned
 * @private
 */
function assignAllPartitions(numOfPartitions, partitionsAssigned) {
  for (var i = 0; i < numOfPartitions; i++) {
    partitionsAssigned.push(i)
  }
}

/**
 * Update data structures assigning the partitions to revoke to nodes.
 * @param {Array} addresses
 * @param {Number} partitionsToAssignForEachNode
 * @param {Array} partitionsToRevoke
 * @private
 */
// function updateServers(
//   networkView,
//   partitionsToAssignForEachNode,
//   partitionsToRevoke
// ) {
//   log.debug("TOASSIGN: " + partitionsToAssignForEachNode)
//   log.debug("TOREVOKE: " + partitionsToRevoke)
//   Rx.Observable.from(networkView.upPeers)
//     .map(peer => {
//       for (let i = 0; i < partitionsToAssignForEachNode; i++) {
//         const assignedPartition =
//           partitionsToRevoke[partitionsToRevoke.length - 1]
//         log.info(
//           `Assigned partition number ${assignedPartition} to node ${peer.ip
//           }`
//         )
//         let partition = partitionsToRevoke.pop()
//         log.debug("PARTITION IS: " + partition)
//         // when there is an uneven number of nodes, but an even number of partitions to
//         // revoke, it will try to pop when the array is empty
//         if (typeof partition === 'undefined') {
//           continue
//         }
//         peer.partitions.push(partition)
//       }
//       // update addresses
//       const i = networkView.upPeers.findIndex( => e.id === peer.id)
//   if (i >= 0) {
//     addresses[i].partitions = entry.partitions
//   }
//   return entry
// })
//     .subscribe()
// }

/**
 * Reassign partitions across the cluster.
 * @param {*} client client added or removed.
 * @param {Array} peers nodes in the cluster.
 * @returns the partitions assigned.
 * @public
 */

const assignPartitions = (targetIp, networkView, priority) => {
  // the targetIp hasn't been added to network View yet. The function calling this
  // function will put it in after this returns
  let peers = networkView.upPeers
  console.log(utily.inspect(peers, { depth: null }))

  const numberOfNodes = peers.length

  log.info("Number of Partitions: " + numberOfPartitions)
  const partitionsToAssign = Math.round(numberOfPartitions / numberOfNodes)
  log.info("Partitions to assign: " + partitionsToAssign)

  // redo all the other peers partitions
  peers.forEach(peer => {
    if (peer.ip === targetIp) {
      return
    }
    const startIndex = (peer.priority - 1) * partitionsToAssign
    let offset
    if (startIndex + partitionsToAssign > numberOfPartitions) {
      offset = partitionsToAssign - (startIndex + partitionsToAssign - numberOfPartitions)
    }
    else {
      offset = partitionsToAssign
    }

    peer.partitions = [startIndex, offset]
    console.log(peer.partitions)
  })



  // do partitions for this peer

  const startIndex = (priority - 1) * partitionsToAssign
  let offset
  if (startIndex + partitionsToAssign > numberOfPartitions) {
    offset = partitionsToAssign - (startIndex + partitionsToAssign - numberOfPartitions)
  }
  else {
    offset = partitionsToAssign
  }

  const partitionsAssigned = [startIndex, offset]
  return partitionsAssigned
}

/**
 * Revoke partitions assigned to client and split them to other nodes.
 * @param {*} client the client removed from the cluster.
 * @param {Array} addresses nodes in the cluster , optional.
 * @public
 *
 */
const rebalancePartitions = (networkView) => {
  console.log("Inside rebalancer")
  let peers = networkView.upPeers
  console.log(utily.inspect(peers, { depth: null }))

  const numberOfNodes = peers.length

  log.info("Number of Partitions: " + numberOfPartitions)
  const partitionsToAssign = Math.round(numberOfPartitions / numberOfNodes)
  log.info("Partitions to assign: " + partitionsToAssign)

  // redo all the peers partitions
  peers.forEach(peer => {
    const startIndex = (peer.priority - 1) * partitionsToAssign
    let offset
    if (startIndex + partitionsToAssign > numberOfPartitions) {
      offset = partitionsToAssign - (startIndex + partitionsToAssign - numberOfPartitions)
    }
    else {
      offset = partitionsToAssign
    }

    peer.partitions = [startIndex, offset]
    console.log(peer.partitions)
  })

  // const peer = networkView.upPeers.find(p => {
  //   return p.id === id
  // })
  // if (peer) {
  //   // save partitions
  //   const partitionsToRevoke = peer.partitions
  //   const priorityOfRemoved = peer.priority
  //   log.debug(`Client disconnected ${host.ip}`)
  //   // clean data structures
  //   const indexToRemove = networkView.findIndex(p => p.id === id)

  //   networkView.upPeers.splice(indexToRemove, 1)
  //   networkView.upPeers.filter(p => p.priority > priorityOfRemoved).forEach(p => p.priority--)
  //   const partitionsToAssignForEachNode = Math.round(
  //     partitionsToRevoke.length / networkView.upPeers.length
  //   )
  //   updateServers(networkView, partitionsToAssignForEachNode, partitionsToRevoke)
  // }
}

/**
 *
 * @param {*} host
 * @param {*} index
 * @param {*} partitionsToRevokeForEachNode
 * @private
 */
const revokePartitions = (peer, partitionsToRevokeForEachNode) => {
  let partitions = peer.partitions
  let revokedPartitions = []
  for (let i = 0; i < partitionsToRevokeForEachNode; i++) {
    const revokedPartition = partitions[partitions.length - 1]
    log.info(
      `Revoked partition number ${revokedPartition} to node ${peer.ip}`
    )
    revokedPartitions.push(partitions.pop())
  }
  return revokedPartitions
}

module.exports = {
  defaultPartitioner: defaultPartitioner,
  assignPartitions: assignPartitions,
  rebalancePartitions: rebalancePartitions
}
