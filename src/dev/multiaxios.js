const axios = require('axios')
const Agent = require('agentkeepalive');



// this was pretty sweet on 384
const MAX_REQUESTS_COUNT = 512
const INTERVAL_MS = 20
let PENDING_REQUESTS = 0

// create new axios instance

const apis = []

for (let i = 0; i < 4; i++) {
    const keepAliveAgent = new Agent({
        // my initial understanding of this was wrong. This is for connection pooling, where
        // we can send multiple requests over the same socket without having to open a new
        // connection. Which, in our case, is not what we want. However maybe we need to
        // start doing this if we are going to query multiple endpoints

        // setting maxSockets to infitity and keepAlive false sets connection: close header
        maxSockets: Infinity,
        keepAlive: false, // this isn't the keepalive header, this is connection pooling
    });
    const api = axios.create({ httpAgent: keepAliveAgent, timeout: 10000 })
    api.interceptors.request.use(function (config) {

        config.metadata = { startTime: new Date() }
        return config;
    }, function (error) {
        return Promise.reject(error);
    });
    api.interceptors.response.use(function (response) {

        response.config.metadata.endTime = new Date()
        response.duration = response.config.metadata.endTime - response.config.metadata.startTime
        return response;
    }, function (error) {
        // this is broken
        error.config.metadata.endTime = new Date();
        error.duration = error.config.metadata.endTime - error.config.metadata.startTime;
        return Promise.reject(error);
    });
    apis.push(api)
}

module.exports = { apis }
