const Redis = require("ioredis")

async function getRedisConnection(host, port = 6379) {
    // Set maxRetriesPerRequest to null to disable this behavior, and every command will wait forever until the connection is alive again (which is the default behavior before ioredis v4).
    const redis = new Redis({
        host: host,
        port: port,
        lazyConnect: true,
        // default
        retryStrategy(times) {
            const delay = Math.min(times * 50, 2000);
            return null;
        },
    });

    while (redis.status !== "ready") {
        console.log("Connecting to redis...")
        try {
            await redis.connect()
        }
        catch (err) {
            await redis.disconnect()
            await sleep(3000)
            console.log("Retrying...")
        }

    }
    return redis
}

let networkView = {
    id: null,
    priority: null,
    partitions: [],
    partitionSize: Infinity,
    redisConfigured: false,
    redisPriority: 6,
    fluxNodes: [],
    ip: "7.7.7.7",
    coordinates: [],
    startTime: null,
    networkState: "UNKNOWN",
    upPeers: [],
    downPeers: [],
    upreachablePeers: [],
    state: "OFFLINE",
    master: "8.8.8.8",
    masterState: null,
    masterStartTime: null,
    socketCount: 0,
    timestamp: 0,
    peerConfirms: 0
}

const redisPort = 33000;
const sentinelPort = 33001;

(async () => {
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
                console.log(`Error configuring Redis: ${err}`)
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
                console.log(`Error configuring Redis: ${err} `)
            }
            console.log("Sentinel configured")
            sentinel.disconnect()
            sentinel.quit()
            let sentinelIps = networkView.upPeers.map((p => p.ip))
            console.log(`Sentinel Ips: ${sentinelIps}`)
            // nodeHunter.start(sentinelIps, [], networkView.coordinates) // start workers with nothing to monitor
            // console.log(results)

        })
    }
})()

