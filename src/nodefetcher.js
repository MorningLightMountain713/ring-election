const rlaxios = require("./rlaxios.js")
const Redis = require("ioredis")
const config = require("./config.js")
const util = require('./util')
const { BEGIN_WORK, REMOVE_FLUXNODE, ADD_FLUXNODE, } = require('./constants.js')

const log = require('./logger')

const SETNAME = "flux:nodes"
let redis
const numPartitions = config.numPartitions
const minFollowers = config.minFollowers

let priorPartitionSize = 0
let priorFollowers = 0
let thisIsAFluxNode = false

async function bootstrapDB(nodes) {
    if (nodes) {
        console.log("First 5 nodes to put in DB: ", nodes.slice(0, 5))
    }
    else {
        console.log("No nodes... bootstrap won't work")
    }

    let keysToSet = []

    for (const [index, node] of nodes.entries()) {
        keysToSet.push(["zadd", SETNAME, index + 1, node])
    }

    const res = await redis.pipeline(keysToSet).exec()
    console.log("First 5 results")
    console.log(res.slice(0, 5))
    console.log("DB has been bootstrapped")
}

function makeZaddCommand(setName, nodes, startingIndex) {
    let keysToAdd = []
    for (let [index, node] of nodes.entries()) {
        keysToAdd.push(["zadd", setName, Number(startingIndex) + index + 1, node])
    }
    return keysToAdd
}

function makeZremCommand(setName, keys) {
    let keysToRem = []
    for (let [index, key] of keys.entries()) {
        keysToRem.push(["zrem", setName, key])
    }
    return keysToRem
}

function makeRedisCommand(expiredNodes, newNodes, priorNodesHighestScore) {
    let zaddCommand = makeZaddCommand(SETNAME, newNodes, priorNodesHighestScore)
    let zremCommand = makeZremCommand(SETNAME, expiredNodes)
    let mergedCommands = [...zaddCommand, ...zremCommand]
    return mergedCommands
}

function nodeDifferences(priorNodes, currentNodes) {
    let expiredNodes = new Set([...priorNodes].filter(x => !currentNodes.has(x)));
    let newNodes = new Set([...currentNodes].filter(x => !priorNodes.has(x)));
    return [Array.from(expiredNodes), Array.from(newNodes)]
}

async function testIfWeAreAFluxNode() {

}

async function GetAllNodes(myIp, myApiPort) {
    // https://api.runonflux.io/daemon/listzelnodes

    // need to do whoami first to figure out our public ip and port we are listening on
    // need to test what port is being listened on
    // this is so we can bypass haproxy and connect to fastest node
    let error = null
    let nodes = []
    let url = "https://api.runonflux.io/daemon/listzelnodes"

    // when using the public endpoint, it's behind HA proxy. The first few times, the
    // proxy directs you to random endpoints (I think this is a bug) and they can have
    // different lists of nodes - which causes a lot of histeris in our app as it tries
    // to remove a bunch / add a bunch. If we just use ourselves as the source of truth,
    // this doesn't happen

    if (myIp && myApiPort && thisIsAFluxNode === false) {
        const testUrl = `http://${myIp}:${myApiPort}/flux/uptime`
        let res
        // fix this up
        try {
            res = await rlaxios.api.get(testUrl, { timeout: 1000 })
        }
        catch (err) {
            // timeout
        }
        if (res) { // undefined if timeout
            thisIsAFluxNode = true
        }
    }

    if (thisIsAFluxNode) {
        url = `http://${myIp}:${myApiPort}/daemon/listzelnodes`
    }

    console.log(`Using ${url} to fetch nodes`)

    const nodesRaw = await rlaxios.api.get(url, {
        timeout: 15 * 1000
    }).catch((e) => {
        console.log(e)
        error = e
    })

    if (!error) {
        console.log(`Etag: ${nodesRaw.headers.etag}`)

        nodes = nodesRaw.data.data.reduce((allNodes, node) => {
            if (node.ip === "") {
                // console.log("Node: " + node.txhash + " has no IP");
                return allNodes;
            }

            let regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?):(6553[0-5]|655[0-2][0-9]|65[0-4][0-9][0-9]|6[0-4][0-9][0-9][0-9][0-9]|[1-5](\d){4}|[1-9](\d){0,3})$/
            let ip = (regex.test(node.ip)) ? node.ip : node.ip + ":16127"
            allNodes.push(ip);
            return allNodes;
        }, []);
    }
    return { currentNodes: nodes, error: error }
}

async function UpdateCurrentNodeList(sockets, networkView) {
    console.log("getting all nodes...")
    let { currentNodes, error } = await GetAllNodes(networkView.ip, networkView.apiPort);
    if (!error) {
        let priorNodesHighestScore = await redis.zrange(SETNAME, -1, -1, "WITHSCORES")
        priorNodesHighestScore = priorNodesHighestScore[1]
        console.log("Highest set score (not cardinality)")
        console.log(priorNodesHighestScore)

        let partitionSize = Math.trunc(currentNodes.length / (numPartitions - 1))
        // we probably don't need this as you can zrange whatever you want and it will just
        // give you the remainder anyway, just the start index matters
        let remainder = currentNodes.length % (numPartitions - 1);
        // whoever has partition 127 gets the remainder

        let priorNodes = await redis.zrange(SETNAME, 0, -1) // all nodes
        let priorNodesSet = new Set(priorNodes)
        let currentNodesSet = new Set(currentNodes)

        let [expiredNodes, newNodes] = nodeDifferences(priorNodesSet, currentNodesSet)
        console.log("expired:")
        console.log(expiredNodes)
        if (expiredNodes.length > 0 && networkView.upPeers.length >= minFollowers) {
            util.broadcastMessage(sockets, { type: REMOVE_FLUXNODE, nodes: expiredNodes })
        }
        console.log("new:")
        console.log(newNodes)
        // broadcast new nodes
        if (newNodes.length > 0 && networkView.upPeers.length >= minFollowers) {
            util.broadcastMessage(sockets, { type: ADD_FLUXNODE, nodes: newNodes })
        }

        // fix this, sloppy
        let redisCommand = makeRedisCommand(expiredNodes, newNodes, priorNodesHighestScore)
        console.log("Redis command:")
        console.log(redisCommand)
        if (redisCommand.length) {
            await redis.pipeline(redisCommand).exec()
        }

        // node added / remove - just broadcast it

        let broadcastRestart = false

        console.log("Prior partitions: ", priorPartitionSize)
        console.log("Current partitions: ", partitionSize)
        console.log("Prior followers: ", priorFollowers)
        console.log("Current followers: ", networkView.upPeers.length)
        // if we're at critical mass and a node has been added or removed
        if (priorFollowers != networkView.upPeers.length && networkView.upPeers.length >= minFollowers) {
            priorFollowers = networkView.upPeers.length
            broadcastRestart = true
        }
        // total fluxnodes changed so partition size has changed and needs recalculating
        if (priorPartitionSize != partitionSize && networkView.upPeers.length >= minFollowers) {
            priorPartitionSize = partitionSize
            broadcastRestart = true
        }
        if (broadcastRestart) {
            util.broadcastMessage(sockets, { type: BEGIN_WORK, partitionSize: partitionSize })
        }
    } else {
        console.log("Timeout getting node data... skipping")
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runNodeFetcher(sockets, networkView, priorNodeCount) {
    let retries = 0
    redis = await util.getRedisConnection("fluxredisJson_Cerebro")
    console.log("Bootstrapping...")
    // need to check error here, and loop until sorted
    const { currentNodes } = await GetAllNodes(networkView.ip, networkView.apiPort);
    await bootstrapDB(currentNodes)
    while (networkView.upPeers.length < priorNodeCount || retries >= 20) {
        console.log(`Waiting 60 seconds for previous nodes to join. Current: ${networkView.upPeers.length}, Prior: ${priorNodeCount} Retries: ${retries}`)
        await sleep(3000)
        retries++
    }
    setInterval(UpdateCurrentNodeList, 60 * 1000, sockets, networkView)
}

module.exports = runNodeFetcher

