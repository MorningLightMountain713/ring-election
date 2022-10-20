#!/bin/bash

# Need to check for env vars here... set sane defaults if missing
echo $REDIS_PORT
echo $SENTINEL_PORT
echo $COMMS_PORT

# gets the container name
# dig -x `ifconfig eth0 | grep 'inet' | awk '{print $2}'` +short | cut -d'.' -f1

/usr/sbin/sshd &

echo "Node start up"
npm run start
