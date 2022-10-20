var socketconnector = require('./socketconnector.js')

seedNodes = ['116.251.187.91:16127', '116.251.187.92:16127', '116.251.187.93:16127', "116.251.187.194:16127"]
let promises = []

for (let node of seedNodes) {
    promises.push(socketconnector(node))
}

(async () => {
    let sockets
    try {
        sockets = await Promise.all(promises)
    }
    catch (err) {
        console.log(err)
        return
    }

    const leaders = sockets.filter(x => x)
    console.log(leaders.pop().remoteAddress)
})()

