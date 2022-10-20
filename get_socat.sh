#!/bin/bash

# MYIP=$(curl -s ifconfig.me)

REDIS_PORT="${REDIS_PORT:=6379}"
SENTINEL_PORT="${SENTINEL_PORT:=26379}" 
COMMS_PORT="${COMMS_PORT:=3000}" 

echo REDIS_PORT: $REDIS_PORT
echo SENTINEL_PORT: $SENTINEL_PORT
echo COMMS_PORT: $COMMS_PORT

daemon --name redis_socat -X "socat TCP-LISTEN:$REDIS_PORT,fork,allow-table=allow,deny-table=deny TCP:flux_cerebro_redisjson:6379" --delay 15 --respawn
daemon --name sentinel_socat -X "socat TCP-LISTEN:$SENTINEL_PORT,fork,allow-table=allow,deny-table=deny TCP:flux_cerebro_sentinel:26379" --delay 15 --respawn
daemon --name node_socat -X "socat TCP-LISTEN:$COMMS_PORT,fork,allow-table=allow,deny-table=deny TCP:127.0.0.1:3000" --delay 15 --respawn

while true
do

    EXCLUDE=(116.251.187.90 116.251.187.91 116.251.186.42)

    RESPONSE=$(curl -f -s "https://api.runonflux.io/apps/location?appname=FluxBenchAggregator") 

    ret=$?

    if [ $ret -ne 0 ]; then
        echo "Error getting nodes... exiting"
        sleep 60
        continue
    fi

    NODES=$(echo $RESPONSE | jq -r '.data | map(.ip | sub(":[0-9]*"; "")) | join(" ")')

    for i in "${EXCLUDE[@]}"
    do
        NODES=(${NODES[@]//*$i*})
    done

    SOCAT_FILTER=$(IFS=, ; echo "${NODES[*]}")

    echo "Updating socat filter..."

    echo "ALL: $SOCAT_FILTER" > allow

    echo "Filter updated... sleeping 60"
sleep 60
done
