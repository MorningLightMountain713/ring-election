const rlaxios = require("axios")


class Algorithm {
    async *run() {
        this.url = "http://116.251.187.91:16127/flux/info"
        this.controller = new AbortController();
        this.running = true
        while (this.running) {
            await sleep(2000)
            yield this.getNodeData()
        }
    }
    halt() {
        this.running = false
    }
    async getNodeData() {
        let res
        try {
            res = await rlaxios
                .get(this.url, {
                    signal: this.controller.signal,
                })
        } catch (err) {
            console.log(err)
        }
        return res.data.data.daemon.info.blocks
    }
    [Symbol.asyncIterator] = this.run
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

async function main() {
    const foo = new Algorithm          // init
    setTimeout(_ => foo.halt(), 6000) // stop at some point, for demo
    for await (const x of foo)         // iterate
        console.log("data", x)           // log, api call, write fs, etc
    return "kawabunga"                      // return something when done
}

main().then(console.log, console.error) // "done"
