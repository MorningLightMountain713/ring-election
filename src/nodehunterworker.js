// worker
const Redis = require("ioredis")
const rlaxios = require("./rlaxios.js")
const config = require("./config.js")

const { setTimeout } = require('timers/promises')

let redis = null
let redisTimer = null// timeout for putting data in redis. Happens once a minute
let errorReportTimer = null
const sentinelPort = config.sentinelPort
let fluxNodes = new Set()
let monitoredNodes = []
let sentinels = null
let ourCoordinates = null

// function sleep(ms) {
//     return new Promise(r => setTimeout(r, ms))
// }

class FluxNode {
    constructor(serverCoordinates, msDelay, ip, port = null, endpoint = "/flux/info") {
        this.ip = ip;
        this.port = port;
        this.uri = port ? this.ip + ":" + this.port : this.ip + ":16127";
        this.endpoint = endpoint
        this.url = "http://" + this.uri + this.endpoint;
        this.nextFetch = msDelay
        this.isContactable = null;
        this.controller = new AbortController();
        this.latestErr = null;
        this.latestResponseDuration = 0;
        this.running = false;
        this.serverCoordinates = serverCoordinates // should probably just use global
        this.coordinates = null
        this.distanceToServer = Infinity
        // think this takes up a reasonable amount of memory. However, guess it's a
        // tradeoff between storing in memory, or io penalty of writing to Redis.
        this.responseHistory = []
        this.errCount = 0;

        // ToDo: some validations above
    }

    /**
  * Calculates the haversine distance between point A, and B.
  * @param {number[]} latlngA [lat, lng] point A
  * @param {number[]} latlngB [lat, lng] point B
  * @param {boolean} isMiles If we are using miles, else km.
  */
    haversineDistance([lat1, lon1], [lat2, lon2], isMiles = false) {
        const toRadian = angle => (Math.PI / 180) * angle;
        const distance = (a, b) => (Math.PI / 180) * (a - b);
        const RADIUS_OF_EARTH_IN_KM = 6371;

        const dLat = distance(lat2, lat1);
        const dLon = distance(lon2, lon1);

        lat1 = toRadian(lat1);
        lat2 = toRadian(lat2);

        // Haversine Formula
        const a =
            Math.pow(Math.sin(dLat / 2), 2) +
            Math.pow(Math.sin(dLon / 2), 2) * Math.cos(lat1) * Math.cos(lat2);
        const c = 2 * Math.asin(Math.sqrt(a));

        let finalDistance = RADIUS_OF_EARTH_IN_KM * c;

        if (isMiles) {
            finalDistance /= 1.60934;
        }

        return finalDistance;
    }

    async sleep() {
        try {
            await setTimeout(this.nextFetch, undefined, { signal: this.controller.signal });
        } catch {
            // Ignore rejections here
        }
    }

    // average(array) { return array.reduce((a, b) => a + b) / array.length }

    stop() {
        this.running = false
        this.controller.abort();
    }

    async loopData() {
        for await (const result of this) {
            if (result) {
                this.putDataInRedis(result)
            }

        }
    }

    async * run() {
        this.running = true
        while (this.running) {
            await this.sleep(this.nextFetch)
            yield this.getNodeData()
        }
    }

    putDataInRedis(data) {
        // should update this to use txid - store it on the root of each fluxNode instance
        const redisKey = `flux:nodes:${this.uri}`
        let command = ["JSON.SET", redisKey, "$", JSON.stringify(data)]
        redis.call(...command)
    }

    async getNodeData() {
        let res
        try {
            res = await rlaxios.api
                .get(this.url, {
                    signal: this.controller.signal,
                })
        } catch (err) {
            // timeout of 3500ms exceeded (Mainly)
            this.errCount++;
            this.isContactable = false;
            this.latestResponseDuration = err.duration;
            this.responseHistory.unshift(err.duration);
            if (this.responseHistory.length >= 6) {
                this.responseHistory.pop();
            }

            // need to expand on this... more than 3 errors and we change to 5 minutes
            this.errCount <= 3 ? this.nextFetch = 60 * 1000 : this.nextFetch = 300 * 1000;

            // we are grouping URIs by error messages. If the error message has the uri
            // in it already, we remove it so as to make it fungible
            this.latestErr = err.message.replace(this.uri, "").trim();
            return null
        }
        // At this point the http request is good, but we're not sure about the payload
        this.isContactable = true;
        this.latestResponseDuration = res.duration;
        this.responseHistory.unshift(res.duration)
        if (this.responseHistory.length > 6) {
            this.responseHistory.pop()
        }

        //arbitrary
        if (this.latestResponseDuration >= 1500) {
            // we are using interceptors so this includes the time the request was
            // queued. I.e. before the socket was created, so not the real response
            // time. Think we will end up having to move to sockets so we can implement
            // this better. If a request is consistently slow over a few requests though,
            // pretty safe to move it to another node. Also probably better to look at
            // the median response time instead of average - using average, one really
            // bad time will skew all the others.
            console.log(`Fluxnode: ${this.uri} took ${this.latestResponseDuration}ms to respond`)
            console.log(this.responseHistory)
            if (Number.isFinite(this.distanceToServer)) {
                console.log(`Distance to node: ${this.distanceToServer}km`)
            }
        }

        if (res.data.status === "error") {
            this.latestErr = "FluxError: " + res.data.data.message
            this.errCount <= 3 ? this.nextFetch = 60 * 1000 : this.nextFetch = 300 * 1000;
            return null
        }
        // node is good, remove latest Error
        this.latestErr = null;
        this.errCount = 0;

        const matches = res.headers['cache-control']?.match(/max-age=(\d+)/);
        // Give node benefit of the doubt and set timeout to 60s
        this.nextFetch = matches ? parseInt(matches[1], 10) * 1000 : 60 * 1000;

        // We only need to do this once, should only do it if we want to orphan node
        if (!Number.isFinite(this.distanceToServer) && res.data.data.geolocation) {
            const lat = res.data.data.geolocation.lat
            const lon = res.data.data.geolocation.lon
            this.coordinates = [lat, lon]
            const dist = this.haversineDistance(this.coordinates, this.serverCoordinates)
            this.distanceToServer = Math.round((dist + Number.EPSILON) * 100) / 100
        }

        return res.data.data
    }
    [Symbol.asyncIterator] = this.run
}

function initiateFluxNodes(nodes) {
    // we have an entire minute to use up... don't need to start them all at the same time\
    // eg 3000 nodes / 60 seconds = 50 per second. So 1000 / 50 = 20ms delay per call
    let msDelayPerNode = 0
    const TIME_ALLOTED = 60
    let numberOfNodes = nodes.length
    let nodesPerSecond = numberOfNodes / TIME_ALLOTED
    if (nodesPerSecond < 1) {
        msDelayPerNode = 0
    } else {
        msDelayPerNode = Math.round(1000 / nodesPerSecond)
    }

    console.log(`Monitoring ${numberOfNodes}`)
    console.log(`Nodes per second: ${nodesPerSecond}`)
    console.log(`ms delay per Node: ${msDelayPerNode}`)

    return addFluxNodes(nodes, msDelayPerNode)
}

function addFluxNodes(nodesToAdd, msDelayPerNode) {
    for (const [index, node] of nodesToAdd.entries()) {
        let [ip, port] = node.split(':')
        let n = new FluxNode(ourCoordinates, msDelayPerNode * index, ip, port)
        fluxNodes.add(n)
        // thid could be problematic if we are trying to stop, (it was getting
        // stuck here when the msdelaypernode was huge during testing, waiting
        // for this timeout to complete)
        // have simplified this a lot
        n.loopData()
    }
    return fluxNodes
}

// async function putNodesInRedis(redis, nodes) {
//     // maybe only put non errored nodes in redis
//     // do debug first but continue if latestErr != null
//     const chunks = sliceIntoChunks(nodes, 30)
//     console.log(chunks)

//     for (const chunk of chunks) {
//         let redisCommands = []
//         for (let node of chunk) {
//             if (node.data === null) continue;
//             // should update this to use txid - store it on the root of each fluxNode instance
//             redisKey = `flux:nodes:${node.uri}`
//             let command = ["call", "JSON.SET", redisKey, "$", JSON.stringify(node.data)]
//             redisCommands.push(command)
//         }
//         console.log(redisCommands)
//         redis.pipeline(redisCommands).exec((err, results) => {
//             if (err) {
//                 console.log(`Error putting nodes in Redis: ${err}`)
//             }
//             // shouldn't have to do anything here
//             // See https://github.com/luin/ioredis#auto-reconnect
//         })
//         // just to split the work up a bit, redis insert is fucking over our cpu cycles
//         await sleep(500)
//     }
// }

// async function putNodesInRedis(redis, nodes) {
//     // maybe only put non errored nodes in redis
//     // do debug first but continue if latestErr != null
//     let redisCommands = []
//     for (let node of nodes) {
//         if (node.data === null) continue;
//         // should update this to use txid - store it on the root of each fluxNode instance
//         redisKey = `flux:nodes:${node.uri}`
//         let command = ["call", "JSON.SET", redisKey, "$", JSON.stringify(node.data)]
//         redisCommands.push(command)
//     }

//     redis.pipeline(redisCommands).exec((err, results) => {
//         if (err) {
//             console.log(`Error putting nodes in Redis: ${err}`)
//         }
//         // shouldn't have to do anything here
//         // See https://github.com/luin/ioredis#auto-reconnect
//     })
// }

// function loopRedisCommands() {

//     setTimeout(() => {
//         if (redisCommandBuffer.length > 0) {
//             let tempBuffer = redisCommandBuffer
//             redisCommandBuffer = []
//             redis.pipeline(tempBuffer).exec((err, results) => {
//                 if (err) {
//                     console.log(`Error putting nodes in Redis: ${err}`)
//                 }
//             })
//         }
//         loopRedisCommands()
//     }, 80)
// }

function start(sentinelUris, fluxUris, thisServerGeoLocation) {

    ourCoordinates = thisServerGeoLocation
    monitoredNodes = fluxUris
    isStarted = true

    sentinels = sentinelUris.map((ip) =>
        ({ host: ip, port: sentinelPort }))

    console.log("Starting redisio (nodehunter)")
    redis = new Redis({
        sentinels: sentinels,
        name: "LEADER",
        connectTimeout: 3000, // testing, shouldn't need this. Need to catch ETIMEDOUT
    })
    // redis = new Redis()

    // need to do something with this. The ioredis errors are annoying when
    // master drops 

    // errorno: 'ETIMEDOUT',
    // code: 'ETIMEDOUT',
    // syscall: 'connect'

    redis.on("error", (err) => {
        // this catches errors during switchover between master nodes
        console.log(err)
    })

    console.log("Nodes to start:", fluxUris)
    console.log("Our coordinates")
    console.log(ourCoordinates)

    fluxNodes = initiateFluxNodes(fluxUris)
    // redisTimer = setInterval(putNodesInRedis, 60 * 1000, redis, fluxNodes)

    errorReportTimer = setInterval(reportErrors, 60 * 1000)
    // loopRedisCommands()
}

function reportErrors() {
    const mu = process.memoryUsage();
    // # bytes / KB / MB / GB
    const heapTotalGb = mu["heapTotal"] / 1024 / 1024 / 1024;
    const heapUsedGb = mu["heapUsed"] / 1024 / 1024 / 1024;
    const heapTotalRounded = Math.round(heapTotalGb * 100) / 100;
    const heapUsedRounded = Math.round(heapUsedGb * 100) / 100;
    console.log(`Heap Total: ${heapTotalRounded}`)
    console.log(`Heap Used: ${heapUsedRounded}`)

    let uncontactableNodes = []
    let errorMessages = {}
    for (const node of fluxNodes) {
        if (node.latestErr) {
            uncontactableNodes.push(node.uri)
            if (node.latestErr in errorMessages) {
                errorMessages[node.latestErr]["uris"].push(node.uri)
            }
            else {
                errorMessages[node.latestErr] = {
                    uris: [node.uri]
                }
            }
        }
    }
    console.log(errorMessages)
    // return ({ uncontactableNodes: uncontactableNodes, errorMessages: errorMessages })
}

function stop() {
    console.log("Stopping flux nodes...")
    for (const node of fluxNodes) {
        node.stop()
        fluxNodes.delete(node)
    }
    clearTimeout(redisTimer)
    clearTimeout(errorReportTimer)
    monitoredNodes = []
    if (redis) {
        redis.disconnect()
    }
}

function monitor(currentNodes) {
    // probably need toadd to monitoredNodes
    const oldNodes = monitoredNodes.filter(n => !currentNodes.includes(n));
    const newNodes = currentNodes.filter(n => !monitoredNodes.includes(n));
    if (oldNodes.length > 0) {
        removeNodes(oldNodes)
    }
    addNodes(newNodes)
}

function addNodes(fluxUris) {
    console.log("Adding flux nodes...")
    monitoredNodes.push(...fluxUris)
    fluxNodes = new Set([...fluxNodes, ...initiateFluxNodes(fluxUris)])
}

function removeNodes(fluxUris) {
    console.log("Removing flux nodes...")
    for (const uri of fluxUris) {
        const index = monitoredNodes.indexOf(uri)
        monitoredNodes.splice(index, 1)
        for (const node of fluxNodes) {
            if (uri === node.uri) {
                node.stop()
                fluxNodes.delete(node)
            }
        }
    }
}

module.exports = {
    start: start,
    stop: stop,
    monitor: monitor,
    addNodes: addNodes,
    removeNodes: removeNodes,
    reportErrors: reportErrors,

}
