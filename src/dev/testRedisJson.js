const Redis = require('ioredis')

async function dostuff(redisCommands) {
    await redis.pipeline(redisCommands).exec()

    // error handling

}

// don't need to disconnect as we stay connected forever
const redis = new Redis({ host: "localhost" })

let node = { uri: "blah", data: { a: 1, b: 2, c: { a: 1 } } }
let redisCommands = []
redisKey = `flux:nodes:${node.uri}`
let command = ["call", "JSON.SET", redisKey, "$", JSON.stringify(node.data)]
redisCommands.push(command)
console.log(redisCommands)

dostuff(redisCommands)
