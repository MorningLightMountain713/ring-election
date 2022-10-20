const net = require('net');
const { resolve } = require('path');
const { MESSAGE_SEPARATOR, CHALLENGE, CHALLENGE_REPLY, CHALLENGE_ACK } = require('./constants')
let dataCallback

// this is the connection from us to other nodes. They could be booting, followers, or
// the leader

// this buffer is okay as it's only for one socket
let buff = ""
function decodeMessages(data) {
    let stringData = data.toString()

    if (!buff && !stringData.startsWith(MESSAGE_SEPARATOR)) {
        console.log("Received a non standard message... discarding")
        return null
    }

    if (!stringData.endsWith(MESSAGE_SEPARATOR)) {
        buff += stringData
        return null
    }

    if (buff) {
        stringData = buff + stringData
        buff = ""
    }
    let messages = stringData.split(MESSAGE_SEPARATOR)
    messages = messages.filter(m => m); // strip empty strings
    // should error check this
    messages = messages.map(m => {
        return JSON.parse(m)
    })
    return messages
}

function onError(e) { console.log("Socket error or end event: " + e) }

function onData(data, resolve, socket, timer, ourIp) {
    // data is a Buffer
    let messages = decodeMessages(data)
    // may need to wait for next onData call
    if (!messages) {
        return
    }

    for (let msg of messages) {
        console.log("Inside socket connector")
        console.log(msg)
        if (msg.type === CHALLENGE) {
            socket.ip = msg.ip
            const challenge = msg.data
            const response = challenge.split("").reverse().join("")
            socket.write(MESSAGE_SEPARATOR + JSON.stringify({ type: CHALLENGE_REPLY, ip: ourIp, data: response }) + MESSAGE_SEPARATOR)
        } else if (msg.type === CHALLENGE_ACK) {
            // we're gravy
            clearTimeout(timer)
            // I just cannot get this to work using named function. I tried comparing
            // them and they are different for some reason. Why can't I just do
            // socket.off('data', dataCallback)
            socket.removeAllListeners('data')
            socket.removeAllListeners('error')
            resolve(socket)
        }
    }
}



module.exports = (ip, port, ourIp) => {
    return new Promise(function (resolve) {
        let socket
        try {
            socket = net.connect({
                host: ip,
                port: port,
            })
        } catch (err) {
            console.log("Socket error: ", err)
            const error = new Error(err)
            error.downPeer = {
                ip: ip,
                port: port,
                timestamp: Date.now(),
            }
            resolve(error)
        }

        const timer = setTimeout(function () {
            socket.destroy()
            socket.unref()
            const error = new Error("Socket timeout")
            error.downPeer = {
                ip: ip,
                port: port,
                timestamp: Date.now(),
            }
            resolve(error)
        }, 5000)
        socket.setNoDelay(true)
        dataCallback = data => { onData(data, resolve, socket, timer, ourIp) }
        // socket.on('connect', onConnect(timer, challenge))
        socket.on('error', e => onError)
        // socket.on('end', e => donothing)
        socket.on('data', dataCallback)
    })
}
