// Accessing v8 module
const v8 = require('v8');
const Redis = require("ioredis")

const SETNAME = "flux:nodes"



async function calculateNodes(partitions, partitionSize) {
    let redisCommand = []
    const redis = new Redis({ host: "flux_cerebro_redisjson" })
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

const stringfunc = calculateNodes.toString()

// Calling v8.serialize() 
console.log(calculateNodes.toString())


const blah = new Function(stringfunc)

console.log(blah)
