const follower = require('./src/cerebro')
const fs = require("fs/promises")
const axios = require("axios")
const config = require("./src/config.js")
const defaultGateway = require('default-gateway');

let seedNodes = config.seedNodes
const appName = config.appName
const ntpPort = config.ntpPort

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomIntFromInterval(min, max) { // min and max included 
  return Math.floor(Math.random() * (max - min + 1) + min)
}

function stripPorts(ips) {
  const output = ips.reduce((allNodes, ip) => {
    // strip all ports off
    const re = /:[0-9]{1,5}/
    const output = ip.replace(re, '');
    allNodes.push(output);
    return allNodes;
  }, []);
  return output
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
    const matches = node.match(re);
    const port = matches ? matches[1] : "17127";

    const nodeIp = node.ip.replace(re, '');

    allNodes.push({ ip: nodeIp, apiPort: port });
    return allNodes;
  }, []);

  return ips
}

///////////////////////////////////////////////////////////////////////////////////////


if (!appName && !seedNodes) {
  console.log("Environment variable `APP_NAME` or `SEED_NODES` must be set... exiting")
  process.exit(1)
}




(async () => {
  // NOT SURE WE STILL NEED THIS NOW THAT THE GATEKEEPER IS SEPERATE

  // we need our default gateway, usually 172.17.0.1. The reason for this is when the
  // sentinel is running on the same node as master, due to routing, the response
  //comes back from the gateway. I.e. outbound packet to our public IP -> goes
  // to socat, who sees the source as the gateway, not ourselves, hairpin life
  const { gateway, _ } = await defaultGateway.v4()

  // so when nodes start up in local dev, they don't all start at the same time
  // just set this real low, no longer needed, can't be bothered removing
  await sleep(randomIntFromInterval(10, 50))

  if (seedNodes) {
    seedNodes = seedNodes.split(",")
    seedNodes = seedNodes.map((node) => {
      let [ip, port] = node.split(":")
      return { ip: ip, apiPort: port }
    })
  } else {
    seedNodes = await getFluxSeedNodes(true)
  }
  follower.start(seedNodes)
  // follower.startMonitoring()

})()
