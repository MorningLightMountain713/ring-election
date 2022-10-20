// worker
const Redis = require("ioredis")
const rlaxios = require("./rlaxios.js")
const config = require("./config.js")

let redis = null
let redisTimer // timeout for putting data in redis. Happens once a minute
const sentinelPort = config.sentinelPort
let fluxNodes = new Set()
let isStarted = false
let sentinels = null

class FluxNode {


    constructor(ip, port = null, endpoint = "/flux/info") {
        this.ip = ip;
        this.port = port;
        this.uri = port ? this.ip + ":" + this.port : this.ip + ":16127";
        this.endpoint = endpoint
        this.url = "http://" + this.uri + this.endpoint;
        this.nextFetch = 0 // i.e. now. In seconds
        this.data = {};
        this.isContactable = null;
        this.bailOut = false;
        this.controller = new AbortController();
        this.timer = null;
        this.latestErr = null;
        this.latestResponseDuration = 0;
        this.responseHistory = []
        this.errCount = 0;

        // ToDo: some validations above

        // this.loopData(this.nextFetch);
    }

    average(array) { return array.reduce((a, b) => a + b) / array.length }

    stop() {
        this.bailOut = true;
        this.controller.abort();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null
        }
        // start using debug logging, lazy
        // console.log(`node ${this.uri} has been stopped`)
    }

    loopData(timeout) { // seconds
        if (this.bailOut) {
            return
        }
        let self = this
        this.timer = setTimeout(async () => {
            let age = await self.getNodeData();
            self.loopData(age);
        }, timeout * 1000);
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
            this.responseHistory.unshift(err.duration)
            if (this.responseHistory.length >= 6) {
                this.responseHistory.pop()
            }

            // need to expand on this... more than 3 errors and we change to 5 minutes
            this.errCount <= 3 ? this.nextFetch = 60 : this.nextFetch = 300;

            // we are grouping URIs by error messages. If the error message has the uri
            // in it already, we remove it so as to make it fungible
            this.latestErr = err.message.replace(this.uri, "").trim();
            return this.nextFetch
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
            console.log(`Fluxnode: ${this.uri} took ${this.latestResponseDuration}ms to respond`)
            console.log(this.responseHistory)
        }
        // if (this.responseHistory.length > 1 && average(this.responseHistory) >= 1000) {
        //     console.log(`Fluxnode: ${this.uri} has an average response time of: ${average(this.responseHistory)}ms over the last ${this.responseHistory} requests`)
        // }

        if (res.data.status === "error") {
            this.latestErr = "FluxError: " + res.data.data.message
            this.errCount <= 3 ? this.nextFetch = 60 : this.nextFetch = 300;
            return this.nextFetch
        }
        // node is good, remove latest Error
        this.latestErr = null;
        this.errCount = 0;

        const matches = res.headers['cache-control']?.match(/max-age=(\d+)/);
        // Give node benefit of the doubt and set timeout to 60s
        this.nextFetch = matches ? parseInt(matches[1], 10) : 60;

        this.data = res.data.data;

        return this.nextFetch;
    }
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
        let n = new FluxNode(ip, port)
        fluxNodes.add(n)
        if (msDelayPerNode > 0) {
            // thid could be problematic if we are trying to stop, (it was getting
            // stuck here when the msdelaypernode was huge during testing, waiting
            // for this timeout to complete)
            setTimeout(() => {
                n.loopData(0)
            }, msDelayPerNode * index)
        }
        else { // no delay between nodes
            n.loopData(0)
        }
    }
    return fluxNodes
}

async function putNodesInRedis(redis, nodes) {
    // maybe only put non errored nodes in redis
    // do debug first but continue if latestErr != null
    let redisCommands = []
    for (let node of nodes) {
        // should update this to use txid - store it on the root of each fluxNode instance
        redisKey = `flux:nodes:${node.uri}`
        let command = ["call", "JSON.SET", redisKey, "$", JSON.stringify(node.data)]
        redisCommands.push(command)
    }

    redis.pipeline(redisCommands).exec((err, results) => {
        if (err) {
            console.log(`Error putting nodes in Redis: ${err}`)
        }
        // shouldn't have to do anything here
        // See https://github.com/luin/ioredis#auto-reconnect
    })
}

process.on('message', function (msg) {
    if (msg.cmd === "startNodes") {
        isStarted = true

        sentinels = msg.sentinels.map((ip) =>
            ({ host: ip, port: sentinelPort }))

        redis = new Redis({
            sentinels: sentinels,
            name: "LEADER",
            connectTimeout: 3000, // testing, shouldn't need this. Need to catch ETIMEDOUT
        })

        // need to do something with this. The ioredis errors are annoying when
        // master drops 

        // errorno: 'ETIMEDOUT',
        // code: 'ETIMEDOUT',
        // syscall: 'connect'

        redis.on("error", (err) => {
            // this catches errors during switchover between master nodes
            console.log(err)
        })

        console.log("Nodes to start:", msg.nodes)
        fluxNodes = initiateFluxNodes(msg.nodes)
        redisTimer = setInterval(putNodesInRedis, 60 * 1000, redis, fluxNodes)
    } else if (msg.cmd === "reportErrors") {
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
        process.send({ cmd: "errors", uncontactableNodes: uncontactableNodes, errorMessages: errorMessages })
    } else if (msg.cmd === "stop") {
        console.log("Worker is stopping fluxnodes...")
        for (const node of fluxNodes) {
            node.stop()
            fluxNodes.delete(node)
        }
        clearTimeout(redisTimer)
        if (redis) {
            redis.disconnect()
        }

        // process.exit(0)
    }
    else if (msg.cmd === "addNodes") {
        console.log("Worker received add nodes command")
        let nodes = msg.nodes
        fluxNodes = new Set([...fluxNodes, ...initiateFluxNodes(nodes)])

        // addFluxNodes(fluxNodes, nodes, 20)
    }
    else if (msg.cmd === "removeNodes") {
        console.log("Worker received remove nodes command")
        let uris = msg.nodes
        for (let uri of uris) {
            for (let node of fluxNodes) {
                if (uri === node.uri) {
                    node.stop()
                    fluxNodes.delete(node)
                }
            }
        }
    }
})
process.send({ cmd: "ready" })
