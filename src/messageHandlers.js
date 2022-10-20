const heartbeat = require('./heartbeat')
const { prepareMessage, writeMessage, broadcastMessage, generateId, getRedisConnection } = require('./util.js')
const { redisPort, commsPort, sentinelPort, numPartitions, timeToBecomeSeed } = require('./config')
const socketconnector = require('./socketconnector.js')
const partitioner = require('./partitioner')
const nodeHunter = require('./nodehunterworker.js')
const populatePartitions = require('./populatepartitions.js')
const log = require('./logger')
const heartbeatCheck = require('./heartcheck')
const nodeFetcher = require('./nodefetcher')

// const util = require('util')

// need to differentiate between public state and private state. Theres some things like
// fluxNodes that we store on the state that are only needed for one thing. Doesn't make
// sense to pollute our public state and have to remove it (hack)

const eventEmitter = require('./eventEmitter')
const CONCENSUS_THRESHOLD = 0.5
const lastPartition = numPartitions - 1

const {
    DISCOVER_REPLY,
    CHALLENGE_ACK,
    GOSSIP,
    LEADER_PROPOSE,
    LEADER_UPGRADE,
    LEADER_ACK,
    NODE_ADDED,
    WELCOME,
    WELCOME_ACK,
    BOOTSTRAP,
    RECONNECT,
    SANITY_CHECK_REPLY,
    LEADER_NAK,
} = require('./constants')

// for tiebreaker
function getLowestIp(ips) {
    let sorted = ips.sort((a, b) => {
        const num1 = Number(a.split(".").map((num) => (`000${num}`).slice(-3)).join(""));
        const num2 = Number(b.split(".").map((num) => (`000${num}`).slice(-3)).join(""));
        return num1 - num2;
    });
    return sorted[0];
}

function ValidateIPaddress(ipaddress) {
    if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress)) {
        return (true)
    }
    return (false)
}

function stripState(networkView) {
    const stateCopy = {}
    Object.assign(stateCopy, networkView)
    delete stateCopy.upPeers
    delete stateCopy.downPeers
    delete stateCopy.fluxNodes
    return stateCopy
}
function updatePeerState(timestamp, networkView, remoteNetworkView) {
    const stateCopy = stripState(remoteNetworkView)
    stateCopy.timestamp = timestamp

    // update findTargetIndex to take id or ip
    const upPeerIndex = findTargetIndex(networkView, stateCopy.ip)
    console.log(`upPeerIndex: ${upPeerIndex}`)

    const downPeerIndex = findTargetIndex(networkView, stateCopy.ip, "downPeers")

    // peer is obviously up, just delete if we have it
    if (downPeerIndex > -1) {
        networkView.downPeers.splice(downPeerIndex, 1)
    }

    // if we have the peer, and it's timestamp is newer, update it. If timestamp is older,
    // we do nothing. If we don't have the peer - we add it
    if (upPeerIndex > -1 && timestamp > networkView.upPeers[upPeerIndex].timestamp) {
        networkView.upPeers[upPeerIndex] = stateCopy
    } else if (upPeerIndex === -1) {
        console.log("Pushing new peer to local state")
        networkView.upPeers.push(stateCopy)
    }
}

function otherPeers(networkView, id) {
    // returns array
    return networkView.upPeers.filter(peer => { return peer.id !== id })
}

function otherSockets(sockets, id) {
    // returns set
    return new Set([...sockets].filter(socket => { return socket.id !== id }))
}

function findTarget(targetNetworkView, objid, peerState = "upPeers") {
    let predicate
    if (ValidateIPaddress(objid)) {
        predicate = (p) => { return p.ip === objid }
    }
    else {
        predicate = (p => { return p.id === objid })
    }
    return targetNetworkView[peerState].find(predicate)
}

function findTargetIndex(targetNetworkView, objid, peerState = "upPeers") {
    let predicate
    if (ValidateIPaddress(objid)) {
        predicate = (p) => { return p.ip === objid }
    }
    else {
        predicate = (p => { return p.id === objid })
    }
    return targetNetworkView[peerState].findIndex(predicate)
}

function findLeaderView(remoteNetworkView) {
    let masterView
    if (remoteNetworkView.master === remoteNetworkView.ip) {
        masterView = remoteNetworkView
    } else { // someone else is master
        masterView = findTarget(remoteNetworkView, remoteNetworkView.master)
    }
    return masterView
}

function findBestLeader(networkView, remoteNetworkView) {
    if (networkView.master === null && remoteNetworkView.master === null) {
        return null
    }

    if (networkView.master && remoteNetworkView.master === null) return networkView.master
    if (networkView.master === null && remoteNetworkView.master) return remoteNetworkView.master

    if (networkView.masterState === "FULL_LEADER" && remoteNetworkView.masterState !== "FULL_LEADER") {
        return networkView.aster
    }
    if (networkView.masterState !== "FULL_LEADER" && remoteNetworkView.masterState === "FULL_LEADER") {
        return remoteNetworkView.master
    }

    if (networkView.masterState === remoteNetworkView.masterState) {
        const remoteStartTime = new Date(remoteNetworkView.masterStartTime)

        if (networkView.masterStartTime < remoteStartTime) {
            return networkView.master
        } else if (networkView.startTime === remoteStartTime) {
            // would be pretty freaky for this to happen but okay
            const lowestIp = getLowestIp([networkView.master, remoteNetworkView.master])
            return lowestIp

        } else if (networkView.masterStartTime > remoteStartTime) {
            return remoteNetworkView.master
        }
    }
}

function NetworkViewNoPeers(targetNetworkView) {
    tempPeerViewOnly = {}
    Object.assign(tempPeerViewOnly, targetNetworkView)
    delete tempPeerViewOnly.upPeers
    delete tempPeerViewOnly.downPeers
    return tempPeerViewOnly
}

function getTimestamp() {
    return Date.now()
}

function deadPeerCallback() {
    // what to do here. Do we need to check the socket state? Just like the deadLeader,
    // we probably need to try reconnect. Who do we need to communicate with that a peer
    // is down. Do we want for the leader to tell us... and if we don't get told within
    // a timeframe, we notify the leader? Do we check with peers if they can contact node
    // do we then route our traffic through them, that would be fucking cool
}

function deadLeaderCallback(heart, sockets, networkView) {
    // have to pass in the state as we are inside a callback from another file
    // try reconnect - if it fails then move on to this stuff
    console.log('seed node disconnected')
    console.log(networkView)
    console.log(`Socket count: ${sockets.size}`)
    console.log(`Up peers count: ${networkView.upPeers.length}`)
    console.log(`Down peers count: ${networkView.downPeers.length}`)
    console.log(`network socket count: ${networkView.socketCount}`)

    const masterIndex = findTargetIndex(networkView, networkView.master)
    console.log(`Dead master index: ${masterIndex}`)
    const downPeer = { ip: null, port: null }
    // there was a reason for this... I can't remember. The object assignment is
    // necessary = {}, or it explodes
    // I think it's because we're passing a refence to the actual object and later on...
    // when it gets dumpstered, we're referencing it or something
    if (masterIndex > -1) {
        Object.assign(downPeer, networkView.upPeers[masterIndex])
        console.log("Down Peer")
        console.log(downPeer)
        networkView.downPeers.push(downPeer)
        networkView.upPeers.splice(masterIndex, 1)
    }

    // keep clients updated
    if (networkView.priority === 1) {
        console.log('Becomming leader')
        networkView.id = null
        networkView.priority = null
        networkView.redisPriority = null
        networkView.partitions = []
        networkView.master = networkView.ip
        networkView.state = "PROVISIONAL_LEADER"
        networkView.masterState = "PROVISIONAL_LEADER"
        networkView.masterStartTime = networkView.startTime
        networkView.upPeers.forEach(p => { p.priority-- })
        nodeHunter.stop()
        setTimeout(() => {
            heartbeatCheck(heart, sockets, networkView)
            if (networkView.socketCount > 0) {
                console.log("Broadcasting leader propose...")
                broadcastMessage(sockets, { type: LEADER_PROPOSE, state: networkView })
            } else {
                networkView.state = "FULL_LEADER"
                networkView.masterState = "FULL_LEADER"
                performLeaderDuties(sockets, networkView)
            }
        }, timeToBecomeSeed)
    } else {
        // // we don't need to do anything here, we already have a connection to leader, just
        // // wait for them to propose themselves
        // networkView.master = null
        // networkView.masterState = null
        networkView.state = "WAITING_FOR_LEADER"
        for (const socket of sockets) {
            console.log("Socket details")
            console.log(socket.id)
            console.log(socket.readyState)
            console.log(socket.ip)
        }
        // connectToNewLeader()
    }
}

function isMaster(networkView) {
    return networkView.ip === networkView.master
}

async function performLeaderDuties(sockets, networkView, priorNodeCount = 0) {
    console.log('Warming up the leader protocols...')
    // networkView.state = "PROVISIONAL_LEADER"
    // networkView.master = networkView.ip
    // networkView.masterState = "PROVISIONAL"
    // networkView.masterStartTime = networkView.startTime

    if (!networkView.redisConfigured) { // we're the OG leader
        networkView.redisConfigured = true

        // expose this
        let sentinel = await getRedisConnection("fluxredisSentinel_Cerebro", 26379)

        sentinel.on("error", (err) => {
            console.log(err)
        })

        const callSentinel = ["call", "sentinel"]
        const SentinelconfigSet = [...callSentinel, "CONFIG", "SET"]

        const removeLeader = [...callSentinel, "REMOVE", "LEADER"]
        const monitorLeader = [...callSentinel, "MONITOR", "LEADER", networkView.ip, redisPort, 2]
        const announcePort = [...SentinelconfigSet, "announce-port", sentinelPort]
        const announceIp = [...SentinelconfigSet, "announce-ip", networkView.ip]
        const downAfter = [...callSentinel, "SET", "LEADER", "down-after-milliseconds", 5000]
        const failOver = [...callSentinel, "SET", "LEADER", "failover-timeout", 15000]
        const parallelSyncs = [...callSentinel, "SET", "LEADER", "parallel-syncs", 1]

        const sentinelCommands = [removeLeader, monitorLeader, announceIp, announcePort, downAfter, failOver, parallelSyncs]

        // [[null, OK], [null, 'blah']]
        const results = await sentinel.pipeline(sentinelCommands).exec()

        console.log("Sentinel configured")
        console.log(results)
        sentinel.disconnect()
    }
    nodeFetcher(sockets, networkView, priorNodeCount)
}

function challengeReply(peerSocket, response, msg) {
    if (msg.data === response) {
        writeMessage(peerSocket, { type: CHALLENGE_ACK })
        // to fix up all the docker fuckery - we can now match ip to socket
        // wonder if this should be on a different varaible so the socket doesn't set
        // remote address to undefined???
        peerSocket.ip = msg.ip
        console.log(`New socket connected, host: ${peerSocket.ip}`)
    }
    // silently fail if the response is no good
}

function discover(peerSocket, networkView, msg) {
    // discover is only sent by a punter making an outbound connection
    // so we are a server
    networkView.networkState = "CONVERGING"
    const remoteNetworkView = msg.state

    // store remote up peers, if we don't have an active connection - connect to them
    // 
    // const myUpPeers = new set(networkView.upPeers)
    // const newPeersForUs = remoteUpPeers.filter(x => !myUpPeers.has(x))

    updatePeerState(getTimestamp(), networkView, remoteNetworkView)

    // check if they have a master and what state the master is in. Depends what our
    // state is, if we are following... we don't need a new master

    // check what their start time is, this is only relevant if we don't have a leader

    // get their coordinates and work out how far away they are ???

    writeMessage(peerSocket, { type: DISCOVER_REPLY, state: networkView })
}

async function discoverReply(sockets, peerSocket, networkView, msg) {
    // this is way to chunky... break down

    if (networkView.state === "DISCOVERING") {
        // this is the first response
        networkView.state = "PROCESSING_PEERS"
    }
    const remoteNetworkView = msg.state

    updatePeerState(getTimestamp(), networkView, remoteNetworkView)

    // check if we have a master... if so, short circuit all of the below

    if (remoteNetworkView.master === null && networkView.master) {
        // or should we just be returning here??? let the leader talk to them?
        // makes it much simpler, then only leader propose comes from leader
        writeMessage(peerSocket, { type: LEADER_PROPOSE, state: networkView })
        return
    }


    console.log(`Our state: ${networkView.state}`)
    console.log(`Remote state ${remoteNetworkView.state}`)
    console.log(`Remote master ${remoteNetworkView.master}`)
    console.log(`Remote masterState ${remoteNetworkView.masterState}`)

    // taking this out, it's not just about us - if they have a prov leader and we have
    // full - we need to stand them down

    // const followerStates = ["CONNECTED_TO_LEADER", "BOOTSTRAPPING"]
    // if (followerStates.includes(networkView.state)) {
    //     console.log("We already have a leader figured out, laters")
    //     return
    // }
    const bestLeader = findBestLeader(networkView, remoteNetworkView)
    // FULL LEADER HANDLER // 
    if (remoteNetworkView.state === "FULL_LEADER") {
        if (bestLeader === remoteNetworkView.ip) {
            networkView.master = remoteNetworkView.ip
            networkView.state = "BOOTSTRAPPING"
            networkView.masterState = "FULL_LEADER"
            console.log("Leader responded, connecting")
            writeMessage(peerSocket, { type: BOOTSTRAP, state: networkView })
        } else {
            writeMessage(peerSocket, { type: LEADER_NAK, state: networkView })
        }
        return
    }

    if (remoteNetworkView.master && remoteNetworkView.masterState === "FULL_LEADER") {
        if (bestLeader === remoteNetworkView.master) {
            console.log("someone else is full leader, waiting for their socket")

            networkView.state = "CONNECTING_TO_LEADER"

            networkView.master = remoteNetworkView.master
            networkView.masterState = "FULL_LEADER"

            // console.log("peerSocket remote address: ", peerSocket.ip)

            // for (let socket of sockets) {
            //     // this is probably shady will only work on outbound sockets
            //     if (socket.remoteAddress === remoteNetworkView.master) {
            //         console.log("We already have a connection to the leader")

            //         // should check if socket open???

            //         networkView.state = "BOOTSTRAPPING"
            //         socket.write(prepareMessage({ type: BOOTSTRAP, state: networkView }))
            //         return
            //     }
            // }

            // removed this. We can just wait for the master to respond... otherwise we get
            // 2 sockets open to same master

            // console.log("Creating new socket to master")

            // const masterSocket = await socketconnector(remoteNetworkView.master, commsPort)

            // networkView.upPeers.push({ ip: masterSocket.remoteAddress, port: masterSocket.remotePort, timestamp: getTimestamp() })
            // console.log("New guy responded, connecting")
            // networkView.state = "BOOTSTRAPPING"
            // masterSocket.write(prepareMessage({ type: BOOTSTRAP, state: networkView }))

        } else {
            writeMessage(peerSocket, { type: LEADER_NAK, state: networkView })
        }
        return
    }
    // END OF FULL LEADER HANDLER // 

    // PROVISIONAL LEADER HANDLER // 
    if (remoteNetworkView.master && remoteNetworkView.masterState === "PROVISIONAL_LEADER") {
        console.log("Remote network has provisional leader")
        if (networkView.master && networkView.masterState === "FULL_LEADER") {
            writeMessage(peerSocket, { type: LEADER_NAK, state: networkView })
            // need to update their state here... they are no longer PROV LEADER -- CONNECTING_TO_LEADER
            return
        } else if (networkView.master && networkView.masterState === "PROVISIONAL_LEADER") {
            console.log("Testing our master vs thiers")
            if (networkView.masterStartTime < remoteNetworkView.masterStartTime) {
                writeMessage(peerSocket, { type: LEADER_NAK, state: networkView })
                // need to update their state here... they are no longer PROV LEADER -- CONNECTING_TO_LEADER
                return
            }
            // ToDo: compare start times, MASTER_NAK the youngest, MASTER_ACK the older
        }   // we take the provisional master
        console.log("Taking the remote master")
        networkView.master = remoteNetworkView.master
        networkView.masterStartTime = remoteNetworkView.startTime
        networkView.masterState = "PROVISIONAL_LEADER"
        if (remoteNetworkView.master === peerSocket.ip) {
            networkView.state = "WAITING_FOR_LEADER"
            writeMessage(peerSocket, { type: LEADER_ACK, state: networkView })
            return
        }
        else { // someone else is master
            console.log("someone else is master, waiting for their DISCOVER_REPLY")
            return
            // console.log("Peer is not master, finding remote")
            // for (let socket of sockets) {
            //     if (socket.ip === remoteNetworkView.master) {
            //         networkView.state = "CONNECTING_TO_LEADER"
            //         // we already have our master
            //         return
            //     }
            // }
            // // removing this for the meantime - too complicated, not proven to be
            // // needed yet

            // // we need to connect to new master. Bit weird, should be in our list
            // // const masterSocket = await socketconnector(remoteNetworkView.master, commsPort)
            // // networkView.upPeers.push({ ip: masterSocket.remoteAddress, masterSocket: peer.remotePort, timestamp: getTimestamp() })
            // // networkView.state = "WAITING_FOR_LEADER"
            // // masterSocket.write(prepareMessage({ type: LEADER_ACK, state: networkView }))
            // // return
            // console.log("We don't have a full connection to master yet... waiting")
            // return
        }

    }
    // END OF PROVISIONAL LEADER HANDLER // 

    // At this point, neither ourselves, or the other peer has a leader, at all. So,
    // shouldn't we just fight it out? why the requirement that we only have one peer?

    // If other peers are doing this... then at some point we will run into 2 provisional
    // peers, which we then deal with above, at the provisional leader bit.

    // this doesn't work if the network is corrupted... what if there are multiple sockets?

    console.log("2 peers duking it out")
    const remoteStartTime = new Date(remoteNetworkView.startTime)

    if (networkView.startTime < remoteStartTime) {
        console.log("we are the winner")
        networkView.state = "PROVISIONAL_LEADER"
        networkView.master = networkView.ip
        networkView.masterState = "PROVISIONAL_LEADER"
        networkView.masterStartTime = networkView.startTime
    } else if (networkView.startTime === remoteStartTime) {
        // would be pretty freaky for this to happen but okay
        const lowestIp = getLowestIp([networkView.ip, remoteNetworkView.ip])

        if (lowestIp === networkView.ip) {
            console.log("we are the winner")
            networkView.state = "PROVISIONAL_LEADER"
            networkView.master = networkView.ip
            networkView.masterState = "PROVISIONAL_LEADER"
            networkView.masterStartTime = networkView.startTime
        } else {
            console.log("we are the loser")
            networkView.state = "WAITING_FOR_LEADER"
            networkView.master = remoteNetworkView.ip
            networkView.masterState = "PROVISIONAL_LEADER"
            networkView.masterStartTime = remoteNetworkView.startTime
        }
    } else if (networkView.startTime > remoteStartTime) {
        console.log("we are the loser")
        networkView.state = "WAITING_FOR_LEADER"
        networkView.master = remoteNetworkView.ip
        networkView.masterState = "PROVISIONAL_LEADER"
        networkView.masterStartTime = remoteNetworkView.startTime
    }
    writeMessage(peerSocket, { type: LEADER_PROPOSE, state: networkView })
}

function leaderPropose(sockets, peerSocket, networkView, msg) {
    // the proposed leader could be anyone
    const remoteNetworkView = msg.state

    updatePeerState(getTimestamp(), networkView, remoteNetworkView)

    // Why is it here?
    // const me = findTarget(remoteNetworkView, networkView.ip)
    // networkView.priority = me.priority

    // NEED TO CHECK IF WE HAVE SINCE RECEIVED A LEADER FROM SOMEONE ELSE, IF SO, WE
    // NEED TO COMPARE LEADERS AND TAKE THE BEST ONE

    if (networkView.master && networkView.master !== remoteNetworkView.master) {
        // compare masters and ACK the best one
    }

    if (remoteNetworkView.master === networkView.ip) {
        // don't think we ever get here?
        networkView.state = "PROVISIONAL_LEADER"
        networkView.master = networkView.ip
        networkView.masterState = "PROVISIONAL_LEADER"
        networkView.masterStartTime = networkView.startTime
    }
    else if (remoteNetworkView.master === remoteNetworkView.ip) {
        // do we need to validate this? Check start time / ips?
        networkView.state = "WAITING_FOR_LEADER"
        networkView.master = remoteNetworkView.ip
        networkView.masterState = "PROVISIONAL_LEADER"
        networkView.masterStartTime = remoteNetworkView.startTime
    } else { // someone else is master, find them

        const master = findTarget(remoteNetworkView, remoteNetworkView.master)

        networkView.master = master.ip
        networkView.masterState = master.state
        networkView.masterStartTime = master.startTime

        for (let socket of sockets) {
            if (socket.ip === networkView.master) {
                networkView.state = "CONNECTING_TO_LEADER"
                socket.write(prepareMessage({ type: LEADER_ACK, state: networkView }))
            }
        }
        return
    }
    writeMessage(peerSocket, { type: LEADER_ACK, state: networkView })
}

function leaderAck(heart, sockets, peerSocket, networkView, msg) {
    // check how many peers have us as the leader, if it's more than 60%, change
    // state to full leader and broadcast a LEADER_UPGRADE

    const remoteNetworkView = msg.state

    updatePeerState(getTimestamp(), networkView, remoteNetworkView)

    // someone has to stop the ack fest
    if (networkView.state === "FULL_LEADER" || networkView.state === "WAITING_FOR_LEADER") {
        // waiting for leader can happen if our first contact is someone who has just
        // started up, then we get word from the leader, we need to stop acking the
        // other guy we told we were leader
        return
    }

    // make this more clear what we are doing
    // last word. Similar concept to dying gasp
    if (!(["PROVISIONAL_LEADER"].includes(networkView.state))) {
        // other peer sending us an ACK in response to our leader proposal. We then
        // need to ack him back so he can tally the votes.

        networkView.master = remoteNetworkView.ip
        networkView.masterState = "FULL_LEADER"
        networkView.masterStartTime = remoteNetworkView.startTime

        writeMessage(peerSocket, { type: LEADER_ACK, state: networkView })
        return
    }
    // only provisional leader does this stuff

    // this means we've just become provisional leader... start doing heartbeat checks
    if (networkView.peerConfirms === 0) {
        heartbeatCheck(heart, sockets, networkView)
    }

    // some is like foreach, but you can shortcircuit by returning true
    networkView.upPeers.some(peer => {
        if (peer.master === networkView.ip) {
            networkView.peerConfirms++
            return true
        }
    })


    console.log(`Peer confirms: ${networkView.peerConfirms}`)

    // this means we need 2 out of 3
    // just doing 50% for testing with 2 nodes
    if ((networkView.peerConfirms / networkView.upPeers.length) >= CONCENSUS_THRESHOLD) {
        console.log("Broadcasting leader upgrade")
        networkView.state = "FULL_LEADER"
        networkView.masterState = "FULL_LEADER"

        performLeaderDuties(sockets, networkView)

        broadcastMessage(sockets, { type: LEADER_UPGRADE, state: networkView })
    }
    // we're just waiting now for more confirms
}

/**
 *  This is received when we have a leader and so does the remote, but the remote
    told us to stand down - if it's not us that's the imposter, we need to 
    contact them to stand down
 * @param {*} sockets 
 * @param {*} peerSocket 
 * @param {*} networkView 
 * @param {*} msg 
 */
function leaderNak(sockets, peerSocket, networkView, msg) {
    let remoteNetworkView = msg.state

    updatePeerState(getTimestamp(), networkView, remoteNetworkView)

    // were fucked. Need to reset redis
    if (networkView.state === "FULL_LEADER") {
        networkView.master = null
        networkView.state = "BROKEN"
        networkView.masterStartTime = null
        networkView.masterState = null
        console.log("Need to reset redis state - totally broken")
        return
    }

    // We are the imposter
    if (networkView.master === networkView.ip) {
        networkView.master = remoteNetworkView.ip
        networkView.masterState = remoteNetworkView.state
        networkView.masterStartTime = remoteNetworkView.startTime
        if (remoteNetworkView.state === "PROVISIONAL_LEADER") {
            networkView.state = "WAITING_FOR_LEADER"
            writeMessage(peerSocket, { type: LEADER_ACK, state: networkView })
        } else if (remoteNetworkView.state === "FULL_LEADER") {
            networkView.state = "BOOTSTRAPPING"
            writeMessage(peerSocket, { type: BOOTSTRAP, state: networkView })
        }
        return
    }

    // ToDo: someone else is master - we should contact them to tell them to bow down

    // keep stumbling on being able to identify a socket by an ip. Probably the easiest
    // solution is during the challenge sequence, the originator of the connection tells
    // the receiver what their ip address is and adds / overwrites it on the socket

}

function leaderUpgrade(peerSocket, networkView, msg) {
    let remoteNetworkView = msg.state
    // means the remote end has confirmed themseles as leader (over 60% confirms)
    // we fall into line

    // need to check our network view, if the leader doesn't match this one... we
    // need to notify the other leader to stand down

    updatePeerState(getTimestamp(), networkView, remoteNetworkView)

    // this should already be set yeah
    networkView.master = remoteNetworkView.ip

    networkView.masterState = "FULL_LEADER"

    // if we have an id set, we've connected to a master before, should come up with
    // a better way of doing this
    const messageType = networkView.id ? RECONNECT : BOOTSTRAP
    // if we have config details we need to RECONNECT instead of bootstrap
    writeMessage(peerSocket, { type: messageType, state: networkView })
}

async function welcome(heart, sockets, peerSocket, networkView, msg) {
    // pass in outbound sockets, filter other peers, destroy sockets???
    const remoteNetworkView = msg.state

    updatePeerState(getTimestamp(), networkView, remoteNetworkView)

    networkView.state = "CONNECTED_TO_LEADER"

    // these are already set in leaderack but if the leader full before we start, 
    // we never leaderack. Probably okay to set these twice? 
    networkView.master = remoteNetworkView.ip
    networkView.masterState = "FULL_LEADER"
    networkView.masterStartTime = remoteNetworkView.startTime

    // peerSocket is master socket
    peerSocket.on('close', () => {
        peerSocket.destroy()
        sockets.delete(peerSocket)
        networkView.socketCount--
        deadLeaderCallback(heart, sockets, networkView)
    })
    // what more do we need to do here?
    peerSocket.on('error', e => { console.log(e) })

    // we've updated the peerState already, can just use our networkview at this point
    let me = remoteNetworkView.upPeers.find(p => {
        return p.ip === networkView.ip
    })

    networkView.id = me.id
    networkView.priority = me.priority
    networkView.redisPriority = me.redisPriority
    networkView.partitions = me.partitions

    console.log(`Id in the ring ${networkView.id}, priority in the ring ${networkView.priority}, redis priority in the ring ${networkView.redisPriority}`)
    console.log(`Assigned partitions: ${networkView.partitions} `)

    // starting sending keep-alives every 1 sec
    heartbeat(peerSocket, networkView.id)
    // eventEmitter.emit(PARTITIONS_ASSIGNED, networkView.partitions)

    if (!networkView.redisConfigured) {
        networkView.redisConfigured = true
        let redis = await getRedisConnection("fluxredisJson_Cerebro")
        const configSet = ["call", "CONFIG", "SET"]

        const priority = [...configSet, "replica-priority", networkView.redisPriority]
        const replicaOf = ["replicaof", networkView.master, redisPort]
        const replicaAnnounceIp = [...configSet, "replica-announce-ip", networkView.ip]
        const replicaAnnouncePort = [...configSet, "replica-announce-port", redisPort]

        const commands = [priority, replicaOf, replicaAnnounceIp, replicaAnnouncePort]

        redis.pipeline(commands).exec((err, results) => {
            if (err) {
                console.log(`Error configuring Redis: ${err} `)
            }
            console.log("Redis replica configured")
            console.log(results)
            redis.disconnect()
            redis.quit()
        })

        let sentinel = await getRedisConnection("fluxredisSentinel_Cerebro", 26379)

        const callSentinel = ["call", "sentinel"]
        const SentinelconfigSet = [...callSentinel, "CONFIG", "SET"]

        const monitorLeader = [...callSentinel, "monitor", "LEADER", networkView.master, redisPort, 2]
        const announcePort = [...SentinelconfigSet, "announce-port", sentinelPort]
        const announceIp = [...SentinelconfigSet, "announce-ip", networkView.ip]
        const downAfter = [...callSentinel, "SET", "LEADER", "down-after-milliseconds", 5000]
        const failOver = [...callSentinel, "SET", "LEADER", "failover-timeout", 15000]
        const parallelSyncs = [...callSentinel, "SET", "LEADER", "parallel-syncs", 1]

        const sentinelCommands = [monitorLeader, announceIp, announcePort, downAfter, failOver, parallelSyncs]

        sentinel.pipeline(sentinelCommands).exec((err, results) => {
            if (err) {
                console.log(`Error configuring Redis: ${err}`)
            }
            console.log("Sentinel configured")
            console.log(results)
            sentinel.disconnect()
            sentinel.quit()
            let sentinelIps = networkView.upPeers.map((p => p.ip))
            console.log(`Sentinel Ips: ${sentinelIps}`)
            nodeHunter.start(sentinelIps, [], networkView.coordinates) // start workers with nothing to monitor
            // console.log(results)

        })
    }
    writeMessage(peerSocket, { type: WELCOME_ACK, state: networkView })
}

function welcomeAck(sockets, socketId, networkView, msg) {
    // received by master
    const remoteNetworkView = msg.state

    updatePeerState(getTimestamp(), networkView, remoteNetworkView)

    // only master receives welcomeAck

    gossip(sockets, socketId, networkView, msg)

}

// this doesn't really describe what is happening here
function nodeAdded(peerSocket, networkView, msg) {
    // sent from master to peer
    console.log('New node added in the cluster')

    const remoteNetworkView = msg.state

    updatePeerState(getTimestamp(), networkView, remoteNetworkView)

    // update node that was added - we will only have a partial view from their DISCOVER

    const newNodeData = findTarget(remoteNetworkView, msg.id)

    console.log(newNodeData)

    // this has to be ip as we don't have the node id yet
    const newNodeIndex = findTargetIndex(networkView, newNodeData.ip)
    console.log(`New node index: ${newNodeIndex}`)
    // our data is old - overwrite it
    if (newNodeData && newNodeIndex > -1) {
        networkView.upPeers[newNodeIndex] = newNodeData
    }
    else if (newNodeData) {
        networkView.upPeers.push(newNodeData)
    } else {
        console.log("Error adding / updating new node")
    }

    // update our partitions
    const me = findTarget(remoteNetworkView, networkView.id)
    if (me) {
        networkView.partitions = me.partitions
    }
    else {
        console.log("Error updating our partitions")
    }


    // should we just update each node with the master details as it will be the freshest
    // yeah???

    // update peer partitions
    networkView.upPeers.forEach(localPeer => {
        // we've already done the new node, also skip leader
        if (localPeer.id === newNodeData.id || localPeer.ip === networkView.master) {
            return
        }
        const target = remoteNetworkView.upPeers.find(remotePeer => {
            return localPeer.id === remotePeer.id
        })
        console.log(target)
        localPeer.partitions = target.partitions
    })

    writeMessage(peerSocket, { type: GOSSIP, state: networkView })
}

function nodeRemoved(sockets, networkView, msg) {
    console.log("Node removed Network view")
    // console.log(util.inspect(networkView, { depth: null }))

    const remoteNetworkView = msg.state

    const upPeerIndex = findTargetIndex(networkView, msg.id)

    console.log(`Node removed index: ${upPeerIndex}`)

    networkView.socketCount--

    // this isn't great. Update - we now have ip on sockets via socket.ip - maybe
    // update now
    let deadSockets = []
    for (let socket of sockets) {
        if (socket.readyState !== "open") {
            console.log(socket.id)
            console.log("Found dead socket")
            deadSockets.push(socket)
        }
    }

    for (let socket of deadSockets) {
        sockets.delete(socket)
    }

    if (upPeerIndex > -1) {
        networkView.downPeers.push(networkView.upPeers[upPeerIndex])
        networkView.upPeers.splice(upPeerIndex, 1)
    }

    // this is the masters view, which has our latest partitions
    let me = remoteNetworkView.upPeers.find(p => {
        return p.ip === networkView.ip
    })

    networkView.priority = me.priority
    networkView.partitions = me.partitions

    console.log(
        `A node was removed from the cluster, now my priority is ${networkView.priority} `
    )
}

async function beginWork(networkView, msg) {
    console.log("Received BEGIN_WORK message from leader")
    networkView.partitionSize = msg.partitionSize
    console.log(`Records per partition has changed to ${networkView.partitionSize}...updating`)
    // do other partition stuff
    networkView.fluxNodes = await populatePartitions(networkView.partitions, networkView.partitionSize)
    // maybe pass in a reason for recalc? does it make a difference. 
    nodeHunter.monitor(networkView.fluxNodes)
    // need to write a function to update nodeHunter sentinel ips for redisio

    // console.log(nodesToMonitor)
}

function gossip(sockets, socketId, networkView, msg) {
    // gossip -> master -> peers. The reason for the extra step through master is so that
    // master can validate the state is correct. Ideally shouldn't have to do this, but
    // makes sense while valid testing doesn't exist.

    const remoteNetworkView = msg.state

    updatePeerState(getTimestamp(), networkView, remoteNetworkView)
    const master = isMaster(networkView)

    if (master) {
        // need to validate the peer state - what they're telling us should match
        // what we have. If not, do not gossip it and take corrective measures

        broadcastMessage(
            otherSockets(sockets, socketId),
            { type: GOSSIP, id: remoteNetworkView.id, state: networkView }
        )
        // exclude remoteNetworkView.id (get peers, create function)
    }

    // followers only
    if (!master) {
        const targetData = findTarget(remoteNetworkView, msg.id)
        const targetIndex = findTargetIndex(networkView, msg.id)


        if (targetData && targetIndex > -1) {
            if (targetData.timestamp > networkView.upPeers[targetIndex].timestamp) {
                // overwrite
                networkView.upPeers[targetIndex] = targetData
            }
        }
        else if (targetData) {
            networkView.upPeers.push(targetData)
        }
    }
}

function addFluxNode(networkView, msg) {
    // if we have the last partition and its length is shorter than partitionSize
    // add the node - otherwise trigger a reshuffle
    // what happens when we are close to the limit - will get a bunch of reshuffles
    // need like some histerisis or something
    if (networkView.partitions[0] + networkView.partitions[1] >= lastPartition) {
        let newNodes = msg.nodes
        networkView.fluxNodes.push(...newNodes)
        nodeHunter.addNodes(newNodes)
    }
}
function removeFluxNode(networkView, msg) {
    let expiredNodes = msg.nodes
    let nodesToRemove = networkView.fluxNodes.filter((node) => {
        return expiredNodes.includes(node)
    })

    if (nodesToRemove.length > 0) {
        networkView.fluxNodes = networkView.fluxNodes.filter((n) => !nodesToRemove.includes(n));
        nodeHunter.removeNodes(nodesToRemove)
    }
}

function heartBeat(heart, msg) {
    heart.set(msg.id, Date.now())
}

function bootstrap(sockets, heart, peerSocket, networkView, msg) {
    // bootstrap is only sent from a follower to a confirmed leader
    const remoteNetworkView = msg.state

    // this seems a bit stupid
    let clientRedisPriority = networkView.upPeers.length === 1 ? 0 : Math.max(...networkView.upPeers.map(p => p.redisPriority ? p.redisPriority : 0))
    clientRedisPriority++

    const priority = networkView.upPeers.length
    let clientIp = remoteNetworkView.ip
    const assignedPartitions = partitioner.assignPartitions(clientIp, networkView, priority)
    console.log("Assigned partitions: ", assignedPartitions)

    const clientId = generateId()
    heart.set(clientId, Date.now())

    let newData = {
        id: clientId,
        partitions: assignedPartitions,
        priority: priority,
        redisPriority: clientRedisPriority,
    }

    let peerIndex = findTargetIndex(networkView, clientIp)

    delete remoteNetworkView.upPeers
    delete remoteNetworkView.downPeers
    delete remoteNetworkView.fluxNodes

    if (peerIndex > -1) {
        networkView.upPeers[peerIndex] = { ...remoteNetworkView, ...newData }
        // just checking the above
        // util.inspect(networkView)

        // so we can find this peer if we need to disconnect them
        // peerSocket.id = clientId

        writeMessage(peerSocket, { type: WELCOME, state: networkView })

        // CHECK THIS!!
        const others = otherSockets(sockets, peerSocket.id)
        if (others.size > 0) {
            broadcastMessage(others, { type: NODE_ADDED, id: clientId, state: networkView })
        }
    }
}

function reconnect(sockets, heart, peerSocket, networkView, msg) {
    // we are the server. So peerSocket is inbound we can't use it for remote address

    // this should get called if network goes down and we are the og leader, not for
    // reconnecting to new leader - this is all wrong, they should bootstrap

    // new host, this is used for the replica-priority. We don't manage it so long as its
    // higher

    const remoteNetworkView = msg.state
    const peerId = remoteNetworkView.id

    const peer = networkView.upPeers.find(p => { return p.id === peerId })

    console.log(peer)

    // we need to do this here as we are storing the details
    // delete remoteNetworkView.upPeers
    // delete remoteNetworkView.downPeerss

    console.log("Peer socketid: ", peerSocket.id);

    [...sockets].map(p => {
        console.log("all other socket id's: ", p.id)
    })

    console.log("Peer socket readyState: ", peerSocket.readyState)
    // drop peers priority here
    // const clientIp = remoteNetworkView.ip

    // let priority = remoteNetworkView.priority
    // const redisPriority = remoteNetworkView.redisPriority

    // this is a bit obtuse, it's actually updating all partitions, (both this peer
    // and all others receive an update)
    const assignedPartitions = partitioner.assignPartitions(peer.ip, networkView, peer.priority)

    // moving this after partionerer - as that uses -1 for the multiplier
    // priority--

    // let peerIndex = networkView.upPeers.findIndex(p => { return p.ip === clientIp });

    // let newData = {
    //     id: peerId,
    //     partitions: assignedPartitions,
    //     priority: priority,
    //     redisPriority: redisPriority,
    // }

    console.log("Assigned partitions: ", assignedPartitions)

    // networkView.upPeers[peerIndex].partitions = assignedPartitions
    peer.partitions = assignedPartitions

    heart.set(peerId, Date.now())

    // peerSocket.id = peerId

    console.log("About to write welcome message")
    console.log(peerSocket.readyState)

    writeMessage(peerSocket, { type: WELCOME, state: networkView })

    //this is fucked... ???
    const others = otherSockets(sockets, peerSocket.id)
    console.log("Other sockets size")
    console.log(others.size)
    if (others.size > 0) {
        broadcastMessage(others, { type: NODE_ADDED, id: peerId, state: networkView })
    }
}

function sanityCheck(networkView, peerSocket) {
    // this message is from an isolated leader, if we respond with a leader, they will
    // shut down their server, and restart and join the crew
    writeMessage(peerSocket, { type: SANITY_CHECK_REPLY, state: networkView })
}

module.exports = {
    challengeReply: challengeReply,
    discover: discover,
    discoverReply: discoverReply,
    leaderPropose: leaderPropose,
    leaderAck: leaderAck,
    leaderNak: leaderNak,
    leaderUpgrade: leaderUpgrade,
    welcome: welcome,
    welcomeAck: welcomeAck,
    nodeAdded: nodeAdded,
    nodeRemoved: nodeRemoved,
    beginWork: beginWork,
    addFluxNode: addFluxNode,
    removeFluxNode: removeFluxNode,
    heartBeat: heartBeat,
    bootstrap: bootstrap,
    reconnect: reconnect,
    sanityCheck: sanityCheck,
    gossip: gossip
}
