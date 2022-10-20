const { rest } = require("lodash");
const rlaxios = require("./rlaxios.js")
controller = new AbortController();
let nextFetch
let isContactable
// let url = 'http://116.251.187.91:16127/flux/info'
let url = 'http://116.251.187.91:16127/flux/info'
let uri = '116.251.187.191:16128'
let errorMessages = {}
let uncontactableNodes = new Set()
let output

// for that fetch experimental warning
process.removeAllListeners('warning');

function average(array) { return array.reduce((a, b) => a + b) / array.length }
async function getNodeData() {
    // this is pretty meh. try / catch is encompassing too much - fix it
    let res
    try {
        res = await rlaxios.api
            .get(url, {
                signal: controller.signal,
            })
    } catch (err) {
        // timeout of 3500ms exceeded (Mainly)
        // console.log(err.message.replace(uri, "").trim())
        console.log(err.duration)
        return
    }
    console.log(res.duration)

}


console.log(average([1252, 1500, 150, 1700]))


// console.log(res.status)
// clearTimeout(timer)
// console.log(res.headers.get("cache-control"))
// return await res.json()


async function blah() {
    let blah = await getNodeData(url)
    // console.log(blah.status)
    // console.log(blah.data)
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

blah()
