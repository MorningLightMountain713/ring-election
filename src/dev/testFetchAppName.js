const axios = require("./rlaxios.js")
const fs = require("fs/promises")

const APP_NAME = process.env.APP_NAME

if (!APP_NAME) {
  console.log("Environment variable `APP_NAME` must be provided... exiting")
  process.exit(1)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getSeedNodes(withPorts = false) {
  let seedNodes
  try {
    seedNodes = await axios.api.get(`https://api.runonflux.io/apps/location?appname=${APP_NAME}`, {
      timeout: 3500,
    })
  }
  catch (err) {
    console.log(err)
    await sleep(10000)
    seedNodes = await getSeedNodes()
  }

  const ips = seedNodes.data.data.reduce((allNodes, node) => {
    // strip all ports off
    let output
    const re = /:[0-9]{1,5}/
    if (!withPorts) {
      output = node.ip.replace(re, '');
    } else {
      if (node.ip.indexOf(":") == -1) {
        node.ip = node.ip + ":16127"
      }
      output = node.ip
    }
    allNodes.push(output);
    return allNodes;
  }, []);

  return ips
}

(async () => {
  let nodes = await getSeedNodes(withPorts = true)
  console.log(nodes)
})()
