const defaultGateway = require('default-gateway');


(async () => {
    let { gateway, interface } = await defaultGateway.v4()
    console.log(gateway)
})()
// gateway = '1.2.3.4', interface = 'en1'
