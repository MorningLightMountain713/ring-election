const Redis = require("ioredis")

const SETNAME = "flux:nodes"

async function calculateNodes(partitions, partitionSize) {
    let redisCommand = []
    const redis = new Redis({ host: "fluxredisJson_Cerebro" })
    const startIndex = partitions[0]
    const offset = partitions[1]
    const endIndex = startIndex + offset
    for (let partition = startIndex; partition < endIndex; partition++) {
        // for (let partition of partitions) {
        const start = partition * partitionSize
        const offset = start + partitionSize - 1
        redisCommand.push(["zrange", SETNAME, start, offset])
    }

    let results = await redis.pipeline(redisCommand).exec()
    redis.disconnect()
    let swarm = results.reduce(
        (accumulator, current) => {
            // if err is null
            if (current[0] === null) {
                accumulator.push(...current[1])
            } // else log
            return accumulator
        }, [])

    return swarm
}

module.exports = calculateNodes
