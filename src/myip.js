const rlaxios = require("./rlaxios.js")

/**
 * get the hosts external ip address
 */
const addressApis = [
    'https://ifconfig.me',
    'https://checkip.amazonaws.com',
    'https://api.ipify.org'
]

async function getMyIp() {
    const addressApi = addressApis.shift()
    addressApis.push(addressApi)
    let data
    try {
        ({ data } = await rlaxios.api.get(addressApi, { timeout: 3000 }))
    }
    catch (err) {
        console.log(`Error getting IP address from ${addressApi}, switching...`)
        // keep shifting through addressApis until we get a result
        return await getMyIp()
    }
    return data.trim()
}


// (async () => {
//     let blah = await getMyIp()
//     console.log(blah)
// })()

module.exports = getMyIp
