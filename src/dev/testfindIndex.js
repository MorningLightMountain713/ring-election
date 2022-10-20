
function ValidateIPaddress(ipaddress) {
    if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress)) {
        return (true)
    }
    return (false)
}

let networkView = {
    upPeers: [{
        id: "dfj32",
        priority: null,
        partitions: [],
        partitionSize: Infinity,
        redisConfigured: false,
        redisPriority: null,
        fluxNodes: [],
        ip: "116.251.187.93",
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
    }],
    downPeers: []
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


console.log(findTargetIndex(networkView, "dfj32", "downPeers"))
