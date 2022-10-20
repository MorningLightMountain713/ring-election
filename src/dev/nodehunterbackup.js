var cluster = require('cluster');
const { cpus } = require("node:os")

const numCPUs = cpus().length;
let workerFluxNodes = []
let timers = {}
var isWorking = false
let monitoredNodes = []
let sentinels = []


function logCurrentErrorData(errorMessages, uncontactableNodes) {
    // console.log("uncontactableNodes:", uncontactableNodes)
    for (const [message, data] of Object.entries(errorMessages)) {
        console.log(`${message}: ${data["uris"].size}`)
    }
    // remove this when figured out why there are so many
    console.log(uncontactableNodes)

    // return { uncontactableNodes: uncontactableNodes, errorMessages: errorMessages }
}

function sliceIntoChunks(arr, chunkSize) {
    const res = [];
    for (let i = 0; i < arr.length; i += chunkSize) {
        const chunk = arr.slice(i, i + chunkSize);
        res.push(chunk);
    }
    return res;
}

//// PUBLIC FUNCTIONS BELOW

function start(uris, nodes = []) {
    sentinels = uris
    let chunkSize = null
    let nodeChunks = null
    monitoredNodes = nodes

    console.log("Starting nodehunter")

    cluster.setupPrimary({
        exec: __dirname + '/nodehunterworker.js',
        args: [],
        silent: false
    })

    // set to 2 for testing
    let numWorkers = numCPUs >= 1 ? 1 : numCPUs
    if (nodes.length > 0) {
        isWorking = true
        chunkSize = Math.ceil(nodes.length / numWorkers)
        nodeChunks = sliceIntoChunks(nodes, chunkSize)
    }


    cluster.on('disconnect', (worker) => {
        // this needs work, we're only dealing with if the node is dead forever,
        // what about restart / errors reconnects etc
        clearTimeout(timers[worker.id])
        delete timers[worker.id]
        let index = workerFluxNodes.map(function (w) { return w.id; }).indexOf(worker.id)
        workerFluxNodes.splice(index, 1)
        console.log(`The worker #${worker.id} has disconnected`);
    });

    // set workers to 4, if we have the cpus else to number of cpus
    for (var i = 0; i < numWorkers; i++) {
        cluster.fork()
    }

    for (const id in cluster.workers) {
        cluster.workers[id].on('message', (msg) => {
            if (msg.cmd === "ready") {
                let chunk = [] // these are the fluxNodes to work on
                // if theres work to do, send it, otherwise chill
                if (nodes.length > 0) {
                    chunk = nodeChunks.shift()
                    nodeChunks.push(chunk)

                    // sentinels for sentiel addresses
                    cluster.workers[id].send({ cmd: "startNodes", nodes: chunk, sentinels: sentinels })
                }

                // so we have a copy of who is doing what (just the uris not the
                // actual objects)
                workerFluxNodes.push({ id: id, nodes: chunk })

            } else if (msg.cmd === "errors") {
                // do aggregation here
                console.log(`worker id: ${id}`)
                // console.log(`Errored nodes from worker id: ${id}`)
                // console.log(msg.uncontactableNodes)
                console.log(msg.errorMessages)
            }
        })
        let timer = setInterval(() => {
            cluster.workers[id].send({ cmd: "reportErrors" })
        }, 60 * 1000)
        timers[id] = timer
    }
    // console.log(workers)
}

function monitor(currentNodes) {
    // probably need toadd to monitoredNodes
    const oldNodes = monitoredNodes.filter(n => !currentNodes.includes(n));
    const newNodes = currentNodes.filter(n => !monitoredNodes.includes(n));
    const workerCount = Object.keys(cluster.workers).length
    const chunkSize = Math.ceil(newNodes.length / workerCount)
    let nodeChunks = sliceIntoChunks(newNodes, chunkSize)
    if (oldNodes.length > 0) {
        removeNodes(oldNodes)
    }
    // this will round robin workers
    nodeChunks.map((chunk) => {
        addNodes(chunk)
    })

}

function addNodes(uris) {
    console.log("Adding nodes: ", uris)
    monitoredNodes.push(...uris)
    // make sure workerFluxNodes isn't empty - it shouldn't be this only gets called
    // after we have initiated nodes
    // we lookup the worker with the least nodes to monitor, then give them all
    // to the new worker. Could split them across all workers but meh

    // will refactor design. Follower shouldn't be stopping all nodes each time
    // a new node is addded, should detect which to remove / add. Much cleaner

    // so it turns out that leader can direct us to add nodes before the workers
    // have started, if that's the case, just ignore as they will pick up the nodes
    // to monitor anyway when PARTITION_CHANGE is signalled
    if (workerFluxNodes.length > 0) { // if we have any workers
        let minWorker = workerFluxNodes.reduce((prev, current) => {
            return prev.nodes.length < current.nodes.length ? prev : current
        })
        if (!isWorking) {
            cluster.workers[minWorker.id].send({ cmd: "startNodes", nodes: uris, sentinels: sentinels })
        }
        else {
            cluster.workers[minWorker.id].send({ cmd: "addNodes", nodes: uris })
        }
        minWorker.nodes.push(...uris)
        // workerFluxNodes.push({ id: id, nodes: chunk })
    }
}

function stop() {

    for (let id in cluster.workers) {
        clearTimeout(timers[id])
        delete timers[id]
        cluster.workers[id].send({ cmd: "stop" })
        isWorking = false
    }
    cluster.disconnect(() => {
        console.log("All workers stopped")
        workerFluxNodes = []
    })
}

function removeNodes(uris) {
    // could do this better so it removes multiple at a time but meh
    console.log("Removing nodes:", uris)
    for (let uri of uris) {
        let currentWorker = workerFluxNodes.filter((worker) => {
            return worker.nodes.includes(uri)
        })
        if (currentWorker.length === 1) {
            cluster.workers[currentWorker[0].id].send({ cmd: "removeNodes", nodes: uris })
            let index = currentWorker[0].nodes.indexOf(uri)
            currentWorker[0].nodes.splice(index, 1)
        }
    }
}

// testing stuff

// function sleep(ms) {
//     return new Promise(resolve => setTimeout(resolve, ms));
// }

// start([], ["116.251.187.90:16127", "116.251.187.91:16127", "116.251.187.92:16127", "116.251.187.93:16127"]);

// if (cluster.isPrimary) {
//     console.log("we're primary");

//     (async () => {
//         await sleep(12000)
//         addNodes(["116.251.187.94:16127"])
//         await sleep(12000)
//         removeNodes((["116.251.187.91:16127"]))
//         await sleep(120 * 1000)
//         stop()
//     })()
// }

module.exports = {
    monitor: monitor,
    start: start,
    stop: stop,
    removeNodes: removeNodes,
    addNodes: addNodes,
    logCurrentErrorData: logCurrentErrorData
}

// just here for info
// Redis#call() can be used to call arbitrary Redis commands.
// The first parameter is the command name, the rest are arguments.
// await redis.call("JSON.SET", "flux:nodes", "$", '{"f1": {"a":1}, "f2":{"a":2}}');
// const json = await redis.call("JSON.GET", "doc", "$..f1");
// console.log(json); // [{"a":1}]
