const cerebro = require('./src/cerebro')
const fs = require("fs/promises")
const axios = require("axios")
const config = require("./src/config.js")
const defaultGateway = require('default-gateway');

let seedNodes = config.seedNodes
const appName = config.appName

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFluxSeedNodes() {
  // could check the apps/appspecifications for the port but it's already passed
  // in as an env var
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

// main



(async () => {
  if (!appName && !seedNodes) {
    console.log("Environment variable `APP_NAME` or `SEED_NODES` must be set... exiting")
    await sleep(1000 * 60)
    process.exit(1)
  }

  if (seedNodes) {
    seedNodes = seedNodes.split(",")
    seedNodes = seedNodes.map((node) => {
      let [ip, port] = node.split(":")
      return { ip: ip, apiPort: port }
    })
  } else {
    seedNodes = await getFluxSeedNodes()
  }
  await sleep(1000 * 90) // let the other components start up first (do this better)
  // need to do like PING / PONG thing with redis and maybe connect to self via socat?
  cerebro.start(seedNodes)

})()
