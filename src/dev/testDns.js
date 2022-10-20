const util = require('util');
const dns = require('dns');
const lookup = util.promisify(dns.lookup);

(async () => {
    try {
        result = await lookup('google.com')
        console.log(result)
    } catch (error) {
        console.error(error)
    }
})()
