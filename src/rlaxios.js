const axios = require('axios')
// const Agent = require('agentkeepalive');

// const keepAliveAgent = new Agent({
//     // my initial understanding of this was wrong. This is for connection pooling, where
//     // we can send multiple requests over the same socket without having to open a new
//     // connection. Which, in our case, is not what we want. However maybe we need to
//     // start doing this if we are going to query multiple endpoints

//     // setting maxSockets to infitity and keepAlive false sets connection: close header
//     maxSockets: Infinity,
//     keepAlive: false, // this isn't the keepalive header, this is connection pooling
// });

// const MAX_REQUESTS_COUNT = 512
// const INTERVAL_MS = 20
// let PENDING_REQUESTS = 0

const api = axios.create({ httpAgent: null, timeout: 10000 })

// api.interceptors.request.use(function (config) {
//     return new Promise((resolve, reject) => {
//         let interval = setInterval(() => {
//             if (PENDING_REQUESTS < MAX_REQUESTS_COUNT) {
//                 PENDING_REQUESTS++
//                 clearInterval(interval)
//                 resolve(config)
//             }
//         }, INTERVAL_MS)
//     })
// })

api.interceptors.request.use(function (config) {

    config.metadata = config.metadata || { startTime: new Date() }
    return config;
}, function (error) {
    return Promise.reject(error);
});

// api.interceptors.response.use(function (response) {
//     PENDING_REQUESTS = Math.max(0, PENDING_REQUESTS - 1)
//     return Promise.resolve(response)
// }, function (error) {
//     PENDING_REQUESTS = Math.max(0, PENDING_REQUESTS - 1)
//     return Promise.reject(error)
// })

api.interceptors.response.use(function (response) {
    response.duration = new Date() - response.config.metadata.startTime
    return response;
}, function (error) {
    error.duration = new Date() - error.config.metadata.startTime;
    return Promise.reject(error);
});

module.exports = { api }
