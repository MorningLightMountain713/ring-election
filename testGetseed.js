const axios = require("axios")

async function getFluxSeedNodes() {
    // could check the apps/appspecifications for the port but it's already passed
    // in as an env var
    const appName = "Cerebro"
    let fluxNodes
    try {
        fluxNodes = await axios.get(`https://api.runonflux.io/apps/location?appname=${appName}`, {
            timeout: 3500,
        })
    }
    catch (err) {
        console.log(err)
        await sleep(10000)
        fluxNodes = await getFluxSeedNodes()
    }

    const ips = fluxNodes.data.data.reduce((allNodes, node) => {
        const re = /:([0-9]{1,5})/;
        const matches = node.ip.match(re);
        const port = matches ? matches[1] : "16127";

        const nodeIp = node.ip.replace(re, '');

        allNodes.push({ ip: nodeIp, apiPort: port });
        return allNodes;
    }, []);

    return ips
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
    console.log(await getFluxSeedNodes())
})()

