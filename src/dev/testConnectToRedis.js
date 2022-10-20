// const Redis = require("ioredis");

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRedisConnection(host, port = 6379) {
    // Set maxRetriesPerRequest to null to disable this behavior, and every command will wait forever until the connection is alive again (which is the default behavior before ioredis v4).
    const redis = new Redis({
        host: host,
        port: port,
        lazyConnect: true,
        // default
        retryStrategy(times) {
            const delay = Math.min(times * 50, 2000);
            return delay;
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

(async () => {
    const redisPriority = 55
    const leaderConnected = "116.251.187.90:16127"
    const redisPort = 33000
    const myIp = "116.251.187.92"
    const sentinelPort = 30001


    // Set maxRetriesPerRequest to null to disable this behavior, and every command will wait forever until the connection is alive again (which is the default behavior before ioredis v4).
    // const redis = new Redis({
    //     host: "flux_cerebro_redisjson",
    //     lazyConnect: true,
    //     // default
    //     retryStrategy(times) {
    //         const delay = Math.min(times * 50, 2000);
    //         return delay;
    //     },
    // });

    // redis.on("error", (err) => {
    //     console.log(`Error code: ${err.code}`)
    //     if (err.code === "ENOTFOUND") { }
    // })

    // // make this a function 
    // while (redis.status !== "ready") {
    //     console.log("Connecting to redis...")
    //     try {
    //         await redis.connect()
    //     }
    //     catch (err) {
    //         await redis.disconnect()
    //         await sleep(3000)
    //         console.log("Retrying...")
    //     }

    // }

    const redis = await getRedisConnection("flux_cerebro_sentinel", 26379)

    // const configSet = ["call", "CONFIG", "SET"]

    // const priority = [...configSet, "replica-priority", `${redisPriority}`]
    // const replicaOf = ["replicaof", `${leaderConnected.split(':')[0]}`, `${redisPort}`]
    // const replicaAnnounceIp = [...configSet, "replica-announce-ip", `${myIp}`]
    // const replicaAnnouncePort = [...configSet, "replica-announce-port", `${redisPort}`]

    // const commands = [priority, replicaOf, replicaAnnounceIp, replicaAnnouncePort]

    // redis.pipeline(commands).exec((err, results) => {
    //     if (err) {
    //         console.log(`Error configuring Redis: ${err}`)
    //     }
    //     redis.disconnect()
    // })


    const callSentinel = ["call", "sentinel"]
    const configSet = [...callSentinel, "CONFIG", "SET"]

    const monitorLeader = [...callSentinel, "monitor", "LEADER", `${leaderConnected.split(':')[0]}`, `${redisPort}`, 2]
    const announcePort = [...configSet, "announce-port", `${sentinelPort}`]
    const announceIp = [...configSet, "announce-ip", `${myIp}`]
    const downAfter = [...callSentinel, "SET", "LEADER", "down-after-milliseconds", 5000]
    const parallelSyncs = [...callSentinel, "SET", "LEADER", "parallel-syncs", 1]

    const commands = [monitorLeader, announceIp, announcePort, downAfter, parallelSyncs]

    redis.pipeline(commands).exec((err, results) => {
        if (err) {
            console.log(`Error configuring Redis: ${err}`)
        }
        console.log(results)
        redis.disconnect()
    })
    // redis.call("sentinel", "monitor", "LEADER", `${leaderConnected.split(':')[0]}`, `${redisPort}`, 2).then(() => {
    //     redis.disconnect()
    // })

})()


      //     sentinel announce-port ${sentinelPort}
      //     sentinel announce-ip ${myIp}
      //     sentinel monitor LEADER ${leaderConnected.split(':')[0]} ${redisPort} 2
      //     sentinel down-after-milliseconds LEADER 5000
      //     sentinel failover-timeout LEADER 15000
      //     sentinel parallel-syncs LEADER 1
