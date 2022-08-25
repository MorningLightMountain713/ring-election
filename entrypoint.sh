#!/bin/bash

# Need to check for env vars here... set sane defaults if missing
echo $REDIS_PORT
echo $SENTINEL_PORT
echo $COMMS_PORT
# echo $NTP_PORT

# move this onto it's own container - gatekeeper
# socat TCP-LISTEN:$REDIS_PORT,fork,allow-table=allow,deny-table=deny TCP:flux_cerebro_redisjson:6379 &
# socat TCP-LISTEN:$SENTINEL_PORT,fork,allow-table=allow,deny-table=deny TCP:flux_cerebro_sentinel:26379 &
# socat TCP-LISTEN:$COMMS_PORT,fork,allow-table=allow,deny-table=deny TCP:127.0.0.1:3000 &
# socat TCP-LISTEN:$NTP_PORT,fork,allow-table=allow,deny-table=deny TCP:127.0.0.1:10123 &

/usr/sbin/sshd &

echo "Node start up"
npm run start
