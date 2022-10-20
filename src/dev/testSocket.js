const net = require('net')
const parser = require('http-string-parser');
const axios = require('axios')
const Redis = require('ioredis');

const redis = new Redis()

redisCommandBuffer = []

async function getAllNodes() {
    // https://api.runonflux.io/daemon/listzelnodes

    // need to do whoami first to figure out our public ip and port we are listening on
    // need to test what port is being listened on
    // this is so we can bypass haproxy and connect to fastest node
    let error = null
    let nodes = []

    const url = "https://api.runonflux.io/daemon/listzelnodes"
    const nodesRaw = await axios.get(url, {
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

function putDataInRedis(uri, data) {
    // maybe only put non errored nodes in redis
    // do debug first but continue if latestErr != null
    // should update this to use txid - store it on the root of each fluxNode instance
    const redisKey = `flux:nodes:${uri}`
    let command = ["JSON.SET", redisKey, "$", data]
    redis.call(...command)
}

function loopRedisCommands() {

    setTimeout(() => {
        if (redisCommandBuffer.length > 0) {
            let tempBuffer = redisCommandBuffer
            redisCommandBuffer = []
            redis.pipeline(tempBuffer).exec((err, results) => {
                if (err) {
                    console.log(`Error putting nodes in Redis: ${err}`)
                }
            })
        }
        loopRedisCommands()
    }, 1000)
}

function isJsonString(str) {
    try {
        const o = JSON.parse(str);
        if (o && typeof o === "object") {
            return true
        }
    } catch (e) {
        return false;
    }

    return false;
}

async function blah(timeout = 60000) {
    setTimeout(async () => {
        const rawNodes = await getAllNodes()
        const nodes = rawNodes.currentNodes.splice(0, 1000)
        const start = new Date()
        for (let node of nodes) {
            let buff = ""
            const socket = new net.Socket()

            const timer = setTimeout(() => {
                socket.destroy()
                socket.unref()
                console.log(`node ${node} timed out (10s)`)
            }, 10000)

            socket.connect(node.split(':')[1], node.split(':')[0], () => {
                socket.write(`GET /flux/info HTTP/1.1\r\nHost: ${node}\r\nConnection: close\r\n\r\n`)
            })
            socket.on("data", data => {
                buff += data
            })
            socket.on("close", () => {
                clearTimeout(timer)
                const response = parser.parseResponse(buff.toString());
                socket.destroy()
                socket.unref()
                if (response.body && isJsonString(response.body)) {
                    putDataInRedis(node, response.body);
                }
            })
            socket.on("error", err => {
                console.log(err)
            })
        }
        const end = new Date()
        const duration = end - start
        console.log(`Duration is : ${duration}`)
        blah(60000 - duration)
    }, timeout)
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

(async () => {
    // loopRedisCommands()
    blah(100)
})()
