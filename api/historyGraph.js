const { getConfig, getServers } = require('./_lib/servers')
const history = require('./_lib/history')
const { buildHistoryGraph } = require('./_lib/updates')

// GET /api/historyGraph
// Replaces the WebSocket 'historyGraph' response: serves the historical
// player count points used to render the 24 hour dashboard graph.
module.exports = async (req, res) => {
  const config = getConfig()
  const servers = getServers()

  let payload

  if (!history.configured()) {
    payload = buildHistoryGraph(servers, { timestamps: [], data: [] })
  } else {
    const nowMs = Date.now()
    const window = await history.getWindow(nowMs - config.graphDuration, nowMs)

    payload = buildHistoryGraph(servers, window)
  }

  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=60')
  res.end(JSON.stringify(payload))
}