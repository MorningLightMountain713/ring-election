const expect = require('expect')
const mock = require('mock-require')
const { LEADER_ACK, LEADER_NAK, BOOTSTRAP, MESSAGE_SEPARATOR } = require('../src/constants')
const handlers = mock.reRequire('../src/messageHandlers')

function decodeMessage(data) {
  // could just set decoding
  let messages = data.split(MESSAGE_SEPARATOR)
  messages = messages.filter(m => m); // strip empty strings
  // need to error check this
  messages = messages.map(m => { return JSON.parse(m) })
  return messages[0]
}

describe('Receive DISCOVER', () => {
  it('Should update peer state', () => {
    const timestamp = Date.now()

    const networkView = {
      upPeers: [],
      downPeers: [],
    }

    let count = 0
    /* es-lint-disable no-unused-expressions */
    const peerSocket = {
      write: msg => {
        count++
      },
      writable: true,
      ip: "1.1.1.1"
    }
    const remoteState = { ip: '1.1.1.1', state: "DISCOVERING" }
    const msg = { state: remoteState }

    handlers.discover(peerSocket, networkView, msg)
    expect(count).toBe(1)
    expect(networkView.upPeers[0].ip).toBe('1.1.1.1')
    expect(networkView.upPeers[0].state).toBe('DISCOVERING')
    expect(networkView.upPeers[0].timestamp).toBeGreaterThanOrEqual(timestamp)

  })
})

describe('Receive DISCOVER_REPLY', () => {
  it('Should update state and find remote as leader when we started later', () => {
    const timestamp = Date.now()

    const networkView = {
      state: "DISCOVERING",
      upPeers: [],
      downPeers: [],
      startTime: new Date(timestamp),
    }

    let count = 0
    /* es-lint-disable no-unused-expressions */
    const peerSocket = {
      write: msg => {
        count++
      },
      writable: true,
      ip: "1.1.1.1"
    }

    const sockets = [peerSocket]

    // PROCESSING_PEERS, AWAITING_LEADER, CONNECTING_TO_LEADER, CONNECTED_TO_LEADER", "BOOTSTRAPPING, FULL_LEADER, PROVISIONAL_LEADER

    const remoteState = { ip: '1.1.1.1', state: "PROCESSING_PEERS", master: null, masterState: null, startTime: new Date(timestamp - 1000) }
    const msg = { state: remoteState }

    handlers.discoverReply(sockets, peerSocket, networkView, msg)
    expect(count).toBe(1)
    expect(networkView.upPeers[0].ip).toBe('1.1.1.1')
    expect(networkView.upPeers[0].state).toBe('PROCESSING_PEERS')
    expect(networkView.upPeers[0].timestamp).toBeGreaterThanOrEqual(timestamp)
    expect(networkView.upPeers[0].startTime).toStrictEqual(new Date(timestamp - 1000))
    expect(networkView.state).toBe("WAITING_FOR_LEADER")
    expect(networkView.master).toBe("1.1.1.1")
    expect(networkView.masterState).toBe("PROVISIONAL_LEADER")
    expect(networkView.masterStartTime).toStrictEqual(new Date(timestamp - 1000))
  })
  it('Should update state and find us as leader when we started first', () => {
    const timestamp = Date.now()

    const networkView = {
      state: "DISCOVERING",
      upPeers: [],
      downPeers: [],
      startTime: new Date(timestamp),
      ip: "2.2.2.2"
    }

    let count = 0
    /* es-lint-disable no-unused-expressions */
    const peerSocket = {
      write: msg => {
        count++
      },
      writable: true,
      ip: "1.1.1.1"
    }

    const sockets = [peerSocket]

    // PROCESSING_PEERS, AWAITING_LEADER, CONNECTING_TO_LEADER, CONNECTED_TO_LEADER", "BOOTSTRAPPING, FULL_LEADER, PROVISIONAL_LEADER

    const remoteState = { ip: '1.1.1.1', state: "PROCESSING_PEERS", master: null, masterState: null, startTime: new Date(timestamp + 1000) }
    const msg = { state: remoteState }

    handlers.discoverReply(sockets, peerSocket, networkView, msg)
    expect(count).toBe(1)
    expect(networkView.upPeers[0].ip).toBe('1.1.1.1')
    expect(networkView.upPeers[0].state).toBe('PROCESSING_PEERS')
    expect(networkView.upPeers[0].timestamp).toBeGreaterThanOrEqual(timestamp)
    expect(networkView.upPeers[0].startTime).toStrictEqual(new Date(timestamp + 1000))
    expect(networkView.state).toBe("PROVISIONAL_LEADER")
    expect(networkView.master).toBe("2.2.2.2")
    expect(networkView.masterState).toBe("PROVISIONAL_LEADER")
    expect(networkView.masterStartTime).toStrictEqual(new Date(timestamp))
  })
  it('Should update state and set remote as prov leader if they are prov leader', () => {
    const timestamp = Date.now()

    const networkView = {
      state: "DISCOVERING",
      upPeers: [],
      downPeers: [],
      startTime: new Date(timestamp),
      ip: "2.2.2.2"
    }

    let count = 0
    let msgType = null
    /* es-lint-disable no-unused-expressions */
    const peerSocket = {
      write: msg => {
        count++
        msgType = decodeMessage(msg).type
      },
      writable: true,
      ip: "1.1.1.1"
    }

    const sockets = [peerSocket]

    // PROCESSING_PEERS, AWAITING_LEADER, CONNECTING_TO_LEADER, CONNECTED_TO_LEADER", "BOOTSTRAPPING, FULL_LEADER, PROVISIONAL_LEADER

    const remoteState = { ip: '1.1.1.1', state: "PROVISIONAL_LEADER", master: "1.1.1.1", masterState: "PROVISIONAL_LEADER", startTime: new Date(timestamp - 1000) }
    const msg = { state: remoteState }

    handlers.discoverReply(sockets, peerSocket, networkView, msg)
    expect(count).toBe(1)
    expect(networkView.upPeers[0].ip).toBe('1.1.1.1')
    expect(networkView.upPeers[0].state).toBe('PROVISIONAL_LEADER')
    expect(networkView.upPeers[0].timestamp).toBeGreaterThanOrEqual(timestamp)
    expect(networkView.upPeers[0].startTime).toStrictEqual(new Date(timestamp - 1000))
    expect(networkView.state).toBe("WAITING_FOR_LEADER")
    expect(networkView.master).toBe("1.1.1.1")
    expect(networkView.masterState).toBe("PROVISIONAL_LEADER")
    expect(networkView.masterStartTime).toStrictEqual(new Date(timestamp - 1000))
    expect(msgType).toBe(LEADER_ACK)
  })
  it('Should update state and NAK remote if we have full leader', () => {
    const timestamp = Date.now()

    const networkView = {
      state: "CONNECTED_TO_LEADER",
      upPeers: [{ ip: "3.3.3.3", master: "3.3.3.3", state: "FULL_LEADER", startTime: new Date(timestamp - 30000) }],
      master: "3.3.3.3",
      masterState: "FULL_LEADER",
      downPeers: [],
      startTime: new Date(timestamp),
      ip: "2.2.2.2"
    }

    let count = 0
    let msgType = null
    /* es-lint-disable no-unused-expressions */
    const peerSocket = {
      write: msg => {
        count++
        msgType = decodeMessage(msg).type
      },
      writable: true,
      ip: "1.1.1.1"
    }

    const sockets = [peerSocket]

    // PROCESSING_PEERS, AWAITING_LEADER, CONNECTING_TO_LEADER, CONNECTED_TO_LEADER", "BOOTSTRAPPING, FULL_LEADER, PROVISIONAL_LEADER

    const remoteState = { ip: '1.1.1.1', state: "PROVISIONAL_LEADER", master: "1.1.1.1", masterState: "PROVISIONAL_LEADER", startTime: new Date(timestamp - 1000) }
    const msg = { state: remoteState }

    handlers.discoverReply(sockets, peerSocket, networkView, msg)
    expect(count).toBe(1)
    expect(networkView.upPeers[1].ip).toBe('1.1.1.1')
    expect(networkView.upPeers[1].state).toBe('PROVISIONAL_LEADER')
    expect(networkView.upPeers[1].timestamp).toBeGreaterThanOrEqual(timestamp)
    expect(networkView.upPeers[1].startTime).toStrictEqual(new Date(timestamp - 1000))
    expect(networkView.state).toBe("CONNECTED_TO_LEADER")
    expect(networkView.master).toBe("3.3.3.3")
    expect(networkView.masterState).toBe("FULL_LEADER")
    expect(msgType).toBe(LEADER_NAK)
  })
  it('Should update state and NAK remote if our prov leader is older than theirs', () => {
    const timestamp = Date.now()

    const networkView = {
      state: "WAITING_FOR_LEADER",
      upPeers: [{ ip: "3.3.3.3", master: "3.3.3.3", state: "PROVISIONAL_LEADER", startTime: new Date(timestamp - 30000) }],
      master: "3.3.3.3",
      masterState: "PROVISIONAL_LEADER",
      downPeers: [],
      startTime: new Date(timestamp),
      masterStartTime: new Date(timestamp - 30000),
      ip: "2.2.2.2"
    }

    let count = 0
    let msgType = null
    /* es-lint-disable no-unused-expressions */
    const peerSocket = {
      write: msg => {
        count++
        msgType = decodeMessage(msg).type
      },
      writable: true,
      ip: "1.1.1.1"
    }

    const sockets = [peerSocket]

    // PROCESSING_PEERS, AWAITING_LEADER, CONNECTING_TO_LEADER, CONNECTED_TO_LEADER", "BOOTSTRAPPING, FULL_LEADER, PROVISIONAL_LEADER

    const remoteState = { ip: '1.1.1.1', state: "PROVISIONAL_LEADER", master: "1.1.1.1", masterState: "PROVISIONAL_LEADER", masterStartTime: new Date(timestamp - 1000), startTime: new Date(timestamp - 1000) }
    const msg = { state: remoteState }

    handlers.discoverReply(sockets, peerSocket, networkView, msg)
    expect(count).toBe(1)
    expect(networkView.upPeers[1].ip).toBe('1.1.1.1')
    expect(networkView.upPeers[1].state).toBe('PROVISIONAL_LEADER')
    expect(networkView.upPeers[1].timestamp).toBeGreaterThanOrEqual(timestamp)
    expect(networkView.upPeers[1].startTime).toStrictEqual(new Date(timestamp - 1000))
    expect(networkView.state).toBe("WAITING_FOR_LEADER")
    expect(networkView.master).toBe("3.3.3.3")
    expect(networkView.masterState).toBe("PROVISIONAL_LEADER")
    expect(msgType).toBe(LEADER_NAK)
  })
  it('Should update state and update our master if our prov leader is younger than theirs', () => {
    const timestamp = Date.now()

    const networkView = {
      state: "WAITING_FOR_LEADER",
      upPeers: [{ ip: "3.3.3.3", master: "3.3.3.3", state: "PROVISIONAL_LEADER", startTime: new Date(timestamp - 500) }],
      master: "3.3.3.3",
      masterState: "PROVISIONAL_LEADER",
      downPeers: [],
      startTime: new Date(timestamp),
      masterStartTime: new Date(timestamp - 500),
      ip: "2.2.2.2"
    }

    let count = 0
    let msgType = null
    /* es-lint-disable no-unused-expressions */
    const peerSocket = {
      write: msg => {
        count++
        msgType = decodeMessage(msg).type
      },
      writable: true,
      ip: "1.1.1.1"
    }

    const sockets = new Set([peerSocket])

    // PROCESSING_PEERS, AWAITING_LEADER, CONNECTING_TO_LEADER, CONNECTED_TO_LEADER", "BOOTSTRAPPING, FULL_LEADER, PROVISIONAL_LEADER

    const remoteState = { ip: '1.1.1.1', state: "PROVISIONAL_LEADER", master: "4.4.4.4", masterState: "PROVISIONAL_LEADER", masterStartTime: new Date(timestamp - 1000), startTime: new Date(timestamp - 1000) }
    const msg = { state: remoteState }

    handlers.discoverReply(sockets, peerSocket, networkView, msg)
    expect(count).toBe(0)
    expect(networkView.upPeers[1].ip).toBe('1.1.1.1')
    expect(networkView.upPeers[1].state).toBe('PROVISIONAL_LEADER')
    expect(networkView.upPeers[1].timestamp).toBeGreaterThanOrEqual(timestamp)
    expect(networkView.upPeers[1].startTime).toStrictEqual(new Date(timestamp - 1000))
    expect(networkView.state).toBe("WAITING_FOR_LEADER")
    expect(networkView.master).toBe("4.4.4.4")
    expect(networkView.masterState).toBe("PROVISIONAL_LEADER")
  })
  it('Should update state and BOOTSTRAP if remote is FULL master', () => {
    const timestamp = Date.now()

    const networkView = {
      state: "PROCESSING_PEERS",
      upPeers: [],
      master: null,
      masterState: null,
      downPeers: [],
      startTime: new Date(timestamp),
      masterStartTime: null,
      ip: "2.2.2.2"
    }

    let count = 0
    let msgType = null
    /* es-lint-disable no-unused-expressions */
    const peerSocket = {
      write: msg => {
        count++
        msgType = decodeMessage(msg).type
      },
      writable: true,
      ip: "1.1.1.1"
    }

    const sockets = new Set([peerSocket])

    // PROCESSING_PEERS, AWAITING_LEADER, CONNECTING_TO_LEADER, CONNECTED_TO_LEADER", "BOOTSTRAPPING, FULL_LEADER, PROVISIONAL_LEADER

    const remoteState = { ip: '1.1.1.1', state: "FULL_LEADER", master: "1.1.1.1", masterState: "FULL_LEADER", masterStartTime: new Date(timestamp - 1000), startTime: new Date(timestamp - 1000) }
    const msg = { state: remoteState }

    handlers.discoverReply(sockets, peerSocket, networkView, msg)
    expect(count).toBe(1)
    expect(networkView.upPeers[0].ip).toBe('1.1.1.1')
    expect(networkView.upPeers[0].state).toBe('FULL_LEADER')
    expect(networkView.upPeers[0].timestamp).toBeGreaterThanOrEqual(timestamp)
    expect(networkView.upPeers[0].startTime).toStrictEqual(new Date(timestamp - 1000))
    expect(networkView.state).toBe("BOOTSTRAPPING")
    expect(networkView.master).toBe("1.1.1.1")
    expect(networkView.masterState).toBe("FULL_LEADER")
    expect(msgType).toBe(BOOTSTRAP)
  })
  it('Should update state and NAK if our FULL_LEADER is older', () => {
    const timestamp = Date.now()

    const networkView = {
      state: "CONNECTED_TO_LEADER",
      upPeers: [{ ip: "3.3.3.3", master: "3.3.3.3", state: "FULL_LEADER", startTime: new Date(timestamp - 2000), masterStartTime: new Date(timestamp - 2000) }],
      master: "3.3.3.3",
      masterState: "FULL_LEADER",
      downPeers: [],
      startTime: new Date(timestamp),
      masterStartTime: new Date(timestamp - 2000),
      ip: "2.2.2.2"
    }

    let count = 0
    let msgType = null
    /* es-lint-disable no-unused-expressions */
    const peerSocket = {
      write: msg => {
        count++
        msgType = decodeMessage(msg).type
      },
      writable: true,
      ip: "1.1.1.1"
    }

    const sockets = new Set([peerSocket])

    // PROCESSING_PEERS, AWAITING_LEADER, CONNECTING_TO_LEADER, CONNECTED_TO_LEADER", "BOOTSTRAPPING, FULL_LEADER, PROVISIONAL_LEADER

    const remoteState = { ip: '1.1.1.1', state: "FULL_LEADER", master: "1.1.1.1", masterState: "FULL_LEADER", masterStartTime: new Date(timestamp - 1000), startTime: new Date(timestamp - 1000) }
    const msg = { state: remoteState }

    handlers.discoverReply(sockets, peerSocket, networkView, msg)
    expect(count).toBe(1)
    expect(networkView.upPeers[1].ip).toBe('1.1.1.1')
    expect(networkView.upPeers[1].state).toBe('FULL_LEADER')
    expect(networkView.upPeers[1].timestamp).toBeGreaterThanOrEqual(timestamp)
    expect(networkView.upPeers[1].startTime).toStrictEqual(new Date(timestamp - 1000))
    expect(networkView.state).toBe("CONNECTED_TO_LEADER")
    expect(networkView.master).toBe("3.3.3.3")
    expect(networkView.masterState).toBe("FULL_LEADER")
    expect(msgType).toBe(LEADER_NAK)
  })
  it('Should update state and wait for leader socket if their FULL_LEADER is better', () => {
    const timestamp = Date.now()

    const networkView = {
      state: "CONNECTED_TO_LEADER",
      upPeers: [{ ip: "3.3.3.3", master: "3.3.3.3", state: "FULL_LEADER", startTime: new Date(timestamp - 2000), masterStartTime: new Date(timestamp - 2000) }],
      master: "3.3.3.3",
      masterState: "FULL_LEADER",
      downPeers: [],
      startTime: new Date(timestamp),
      masterStartTime: new Date(timestamp - 2000),
      ip: "2.2.2.2"
    }

    let count = 0
    let msgType = null
    /* es-lint-disable no-unused-expressions */
    const peerSocket = {
      write: msg => {
        count++
        msgType = decodeMessage(msg).type
      },
      writable: true,
      ip: "1.1.1.1"
    }

    const sockets = new Set([peerSocket])

    // PROCESSING_PEERS, AWAITING_LEADER, CONNECTING_TO_LEADER, CONNECTED_TO_LEADER", "BOOTSTRAPPING, FULL_LEADER, PROVISIONAL_LEADER

    const remoteState = { ip: '1.1.1.1', state: "CONNECTED_TO_LEADER", master: "4.4.4.4", masterState: "FULL_LEADER", masterStartTime: new Date(timestamp - 3000), startTime: new Date(timestamp + 100) }
    const msg = { state: remoteState }

    handlers.discoverReply(sockets, peerSocket, networkView, msg)
    expect(count).toBe(0)
    expect(networkView.upPeers[1].ip).toBe('1.1.1.1')
    expect(networkView.upPeers[1].state).toBe('CONNECTED_TO_LEADER')
    expect(networkView.upPeers[1].timestamp).toBeGreaterThanOrEqual(timestamp)
    expect(networkView.upPeers[1].startTime).toStrictEqual(new Date(timestamp + 100))
    expect(networkView.state).toBe("CONNECTING_TO_LEADER")
    expect(networkView.master).toBe("4.4.4.4")
    expect(networkView.masterState).toBe("FULL_LEADER")
  })
})
