/**
 * Created to keep constants here.
 */
'use strict'

const CHALLENGE = 'CHALLENGE'
const CHALLENGE_REPLY = 'CHALLENGE_REPLY'
const CHALLENGE_ACK = 'CHALLENGE_ACK'
const DISCOVER = 'DISCOVER'
const DISCOVER_REPLY = 'DISCOVER_REPLY'
const LEADER_PROPOSE = 'LEADER_PROPOSE'
const LEADER_UPGRADE = 'LEADER_UPGRADE'
const LEADER_ACK = 'LEADER_ACK'
const LEADER_NAK = 'LEADER_NAK'
const NODE_ADDED = 'NODE_ADDED'
const NODE_REMOVED = 'NODE_REMOVED'
const HEART_BEAT = 'HEART_BEAT'
const WELCOME = 'WELCOME'
const WELCOME_ACK = 'WELCOME_ACK'
const RECONNECT = 'RECONNECT'
const BOOTSTRAP = 'BOOTSTRAP'
const MESSAGE_SEPARATOR = '?!£$=?!'
const BECOME_LEADER = 'BECOME_LEADER'
const PARTITIONS_ASSIGNED = 'PARTITIONS_ASSIGNED'
const PARTITIONS_REVOKED = 'PARTITIONS_REVOKED'
const BEGIN_WORK = 'BEGIN_WORK'
const LOCAL_QUORUM_REPLICATION = 'LOCAL_QUORUM'
const QUORUM_REPLICATION = 'QUORUM_REPLICATION'
const TOTAL_REPLICATION = 'TOTAL_REPLICATION'
const REMOVE_FLUXNODE = 'REMOVE_FLUXNODE'
const ADD_FLUXNODE = 'ADD_FLUXNODE'
const SANITY_CHECK = 'SANITY_CHECK'
const SANITY_CHECK_REPLY = 'SANITY_CHECK_REPLY'
const GOSSIP = 'GOSSIP'

module.exports = {
  CHALLENGE: CHALLENGE,
  CHALLENGE_REPLY: CHALLENGE_REPLY,
  CHALLENGE_ACK: CHALLENGE_ACK,
  DISCOVER: DISCOVER,
  DISCOVER_REPLY: DISCOVER_REPLY,
  LEADER_PROPOSE: LEADER_PROPOSE,
  LEADER_UPGRADE: LEADER_UPGRADE,
  LEADER_ACK: LEADER_ACK,
  LEADER_NAK: LEADER_NAK,
  NODE_ADDED: NODE_ADDED,
  NODE_REMOVED: NODE_REMOVED,
  WELCOME: WELCOME,
  WELCOME_ACK: WELCOME_ACK,
  RECONNECT: RECONNECT,
  BOOTSTRAP: BOOTSTRAP,
  MESSAGE_SEPARATOR: MESSAGE_SEPARATOR,
  HEART_BEAT: HEART_BEAT,
  BECOME_LEADER: BECOME_LEADER,
  PARTITIONS_ASSIGNED: PARTITIONS_ASSIGNED,
  PARTITIONS_REVOKED: PARTITIONS_REVOKED,
  BEGIN_WORK: BEGIN_WORK,
  LOCAL_QUORUM_REPLICATION: LOCAL_QUORUM_REPLICATION,
  QUORUM_REPLICATION: QUORUM_REPLICATION,
  TOTAL_REPLICATION: TOTAL_REPLICATION,
  REMOVE_FLUXNODE: REMOVE_FLUXNODE,
  ADD_FLUXNODE: ADD_FLUXNODE,
  SANITY_CHECK: SANITY_CHECK,
  SANITY_CHECK_REPLY: SANITY_CHECK_REPLY,
  GOSSIP: GOSSIP,
}