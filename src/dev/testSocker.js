const net = require('net');

function connectionHandler(peerSocket) {
    // these Id's are local to this box
    peerSocket.id = "fffaaa"

    // merge leader and follower
    peerSocket.setNoDelay(true)
    console.log(`New Client connected host ${JSON.stringify(peerSocket.remoteAddress)}`)

    peerSocket.on('data', () => { console.log(peerSocket) })
}

const server = net.createServer(connectionHandler)

server.listen(3000, '0.0.0.0', function () {
    console.log('Cerebro is listening...')

})
