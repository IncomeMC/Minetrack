const { getConfig, getServers } = require('./_lib/servers')
const history = require('./_lib/history')
const { pingAll } = require('./_lib/ping')
const { buildUpdateServers, getPlayerCountOrNull } = require('./_lib/updates')

// GET /api/servers
// Replaces the WebSocket 'updateServers' broadcast: pings every configured
// server exactly once (in parallel, each bounded by rates.connectTimeout) and
// returns the live state for the frontend. Optionally records a single point
// per minute into Vercel KV for historical tracking.
//
// This function never loops or idles; it performs a single bounded round of
// pings per request and returns.
module.exports = async (req, res) => {
  const config = getConfig()
  const servers = getServers()

  const results = await pingAll(servers, config.rates.connectTimeout)

  const nowMs = Date.now()
  const isGraphVisible = history.configured()

  const counts = servers.map((server, serverId) => getPlayerCountOrNull(results[serverId].resp))

  let recordUpdates = []
  let peaksByIp = null
  let updateHistoryGraph = false

  if (isGraphVisible) {
    try {
      recordUpdates = await history.applyRecordUpdates(servers, counts, nowMs)
      updateHistoryGraph = await history.recordPoint(servers, counts, nowMs)
      peaksByIp = await history.getAllPeaks()
    } catch (err) {
      // A storage failure must never break live tracking
      recordUpdates = []
      updateHistoryGraph = false
    }
  }

  const payload = buildUpdateServers(servers, results, isGraphVisible, recordUpdates, peaksByIp, nowMs, updateHistoryGraph)

  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}