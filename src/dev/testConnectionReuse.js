// const rlaxios = require("./rlaxios.js")
// const axios = require("axios")

// let endpoints = ['http://116.251.187.91:16127/flux/info', 'http://116.251.187.91:16127/apps/installedapps']

// endpoints.map(async (endpoint) => console.log(await rlaxios.api.get(endpoint)))
const http = require('node:http');
const controller = new AbortController();
const signal = controller.signal;

const onResponseCallback = (res) => {
    const { statusCode } = res;
    const contentType = res.headers['content-type'];
    var result = ''
    console.log(res.headers)
    res.on('data', function (chunk) {
        result += chunk;
    });

    res.on('end', function () {
        console.log(result);
    });
}
const keepAliveAgent = new http.Agent({ keepAlive: false });

const options = {
    agent: keepAliveAgent,
    signal: signal,
    timeout: 3000,
}

request = http.get('http://116.251.187.97:16127/flux/info', options, onResponseCallback);

request.on('timeout', () => {
    request.destroy();
});

