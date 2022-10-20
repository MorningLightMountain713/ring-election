const NTP = require('ntp-time').Client;

const ntpServers = ['time.google.com', 'time.cloudflare.com', 'time.nist.gov']
async function getTime() {
    let server = ntpServers.pop()
    ntpServers.unshift(server)
    let time
    let client = new NTP(server, 123, { timeout: 5000 });
    try {
        let ntpPacket = await client.syncTime()
        time = ntpPacket.time
    } catch (err) {
        delete client
        return await getTime()

    }
    return time
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
    let time = await getTime()
    console.log(JSON.stringify(time))
    console.log(typeof time)
    await sleep(300)
    let blah = new Date()
    let duration = blah - time
    console.log(duration)
})()
