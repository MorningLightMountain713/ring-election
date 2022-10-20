var Docker = require('dockerode');

var docker = new Docker()

docker.createContainer({ Image: 'redislabs/rejson:latest', Cmd: ['--sentinel'], name: 'redis-test123' }, function (err, container) {
    container.start(function (err, data) {
    });
});
