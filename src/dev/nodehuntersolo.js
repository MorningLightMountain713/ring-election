const rlaxios = require('./multiaxios.js')
const nodeHunter = require('./nodehunterworker.js')

async function getAllNodes() {
    // https://api.runonflux.io/daemon/listzelnodes

    // need to do whoami first to figure out our public ip and port we are listening on
    // need to test what port is being listened on
    // this is so we can bypass haproxy and connect to fastest node
    let error = null
    let nodes = []

    let axios = rlaxios.apis.pop()
    rlaxios.apis.unshift(axios)

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

(async () => {
    let nodes = await getAllNodes()

    nodeHunter.start([], nodes.currentNodes.splice(0, 3000), [-37.6846, 176.162])
})()

