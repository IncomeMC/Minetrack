const { getConfig, getMinecraftVersions } = require('./servers')

const config = getConfig()

const GRAPH_STEP_MS = 60 * 1000

function getPlayerCountOrNull (resp) {
  if (resp) {
    return resp.players.online
  }

  return null
}

function filterError (err) {
  let message = 'Unknown error'

  for (const key of ['message', 'description', 'errno']) {
    if (err[key]) {
      message = err[key]
      break
    }
  }

  if (message.length > 28) {
    message = message.substring(0, 28) + '...'
  }

  return {
    message
  }
}

// Matches a protocol id against the known version list and returns its index.
// The frontend renders versions by indexing into the names of the matching
// entry, so an index (not a protocol id) is what the payload needs.
function findProtocolIndex (protocolId) {
  const versions = getMinecraftVersions().PC

  for (let i = 0; i < versions.length; i++) {
    if (versions[i].protocolId === protocolId) {
      return i
    }
  }

  return -1
}

function buildConfig (servers, isGraphVisible) {
  const minecraftVersionNames = {}

  Object.keys(getMinecraftVersions()).forEach(key => {
    minecraftVersionNames[key] = getMinecraftVersions()[key].map(version => version.name)
  })

  return {
    graphDurationLabel: config.graphDurationLabel || (Math.floor(config.graphDuration / (60 * 60 * 1000)) + 'h'),
    graphMaxLength: Math.ceil(config.graphDuration / GRAPH_STEP_MS),
    serverGraphMaxLength: Math.ceil(config.serverGraphDuration / config.rates.pingAll),
    servers: servers.map(server => ({
      name: server.name,
      ip: server.ip,
      type: server.type,
      color: server.color
    })),
    minecraftVersions: minecraftVersionNames,
    isGraphVisible,
    rates: {
      pingAll: config.rates.pingAll
    }
  }
}

// Builds the per-server payloads consumed by the frontend's init handler.
// Mirrors ServerRegistration#getPingHistory from the original backend.
function buildInitServers (servers, priorHistory, records, peaks) {
  return servers.map((server, serverId) => {
    const payload = {
      favicon: server.favicon
    }

    if (records && records[server.ip]) {
      payload.recordData = records[server.ip]
    }

    if (peaks && peaks[server.ip] && typeof peaks[server.ip].playerCount === 'number') {
      payload.graphPeakData = peaks[server.ip]
    }

    if (priorHistory && priorHistory.data.length > 0) {
      // Use null to represent failed pings for each historical point
      payload.playerCountHistory = priorHistory.data.map(point => {
        if (!point || typeof point[serverId] !== 'number') {
          return null
        }

        return point[serverId]
      })

      // Assume the last point as the server's current player count
      payload.playerCount = payload.playerCountHistory[payload.playerCountHistory.length - 1]
    } else {
      payload.error = {
        message: 'Pinging...'
      }
    }

    return payload
  })
}

// Builds a single server's update entry for the updateServers payload.
// Mirrors ServerRegistration#getUpdate from the original backend.
function buildServerUpdate (server, result, isGraphVisible, peaksByIp) {
  const update = {}
  const resp = result.resp
  const err = result.err

  // Always append a playerCount value
  // When resp is undefined (due to an error), playerCount will be null
  update.playerCount = getPlayerCountOrNull(resp)

  if (resp) {
    if (resp.version) {
      const protocolIndex = findProtocolIndex(resp.version)

      if (protocolIndex >= 0) {
        update.versions = [protocolIndex]
      }
    }

    if (resp.favicon) {
      update.favicon = resp.favicon
    }

    if (isGraphVisible && peaksByIp && peaksByIp[server.ip] && typeof peaksByIp[server.ip].playerCount === 'number') {
      update.graphPeakData = peaksByIp[server.ip]
    }
  } else if (err) {
    // Append a filtered copy of err
    // This ensures any unintended data is not leaked
    update.error = filterError(err)
  }

  return update
}

// Builds the complete updateServers message consumed by the frontend.
// Mirrors the payload broadcast by PingController#pingAll in the original.
function buildUpdateServers (servers, results, isGraphVisible, recordUpdates, peaksByIp, timestamp, updateHistoryGraph) {
  const updates = servers.map((server, serverId) => {
    const update = buildServerUpdate(server, results[serverId], isGraphVisible, peaksByIp)

    // Only append recordData when a new all-time record was set this round
    if (isGraphVisible && recordUpdates) {
      for (const record of recordUpdates) {
        if (record.ip === server.ip) {
          update.recordData = record.recordData
          break
        }
      }
    }

    return update
  })

  return {
    message: 'updateServers',
    timestamp: Math.floor(timestamp / 1000),
    updateHistoryGraph,
    updates
  }
}

// Builds the historyGraph message consumed by the frontend's big graph.
function buildHistoryGraph (servers, window) {
  const timestamps = window.timestamps.map(timestamp => Math.floor(timestamp / 1000))

  const graphData = servers.map((server, serverId) => {
    return window.data.map(point => {
      if (!point || typeof point[serverId] !== 'number') {
        return null
      }

      return point[serverId]
    })
  })

  return {
    message: 'historyGraph',
    timestamps,
    graphData
  }
}

module.exports = {
  buildConfig,
  buildHistoryGraph,
  buildInitServers,
  buildUpdateServers,
  filterError,
  findProtocolIndex,
  getPlayerCountOrNull
}