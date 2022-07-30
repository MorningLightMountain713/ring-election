const follower = require('./ring/follower')
setTimeout(() => {
  follower.start()
  follower.startMonitoring()
}, randomIntFromInterval(3000, 15000))


function randomIntFromInterval(min, max) { // min and max included 
  return Math.floor(Math.random() * (max - min + 1) + min)
}
