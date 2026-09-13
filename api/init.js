const { getConfig, getServers } = require('./_lib/servers')
const history = require('./_lib/history')
const { buildConfig, buildInitServers } = require('./_lib/updates')

// GET /api/init
// Replaces the WebSocket 'init' handshake message: serves the page
// configuration plus the initial per-server state and graph seeding data.
module.exports = async (req, res) => {
  const config = getConfig()
  const servers = getServers()
  let isGraphVisible = history.configured()

  const nowMs = Date.now()

  let priorHistory = null
  let records = null
  let peaks = null

  if (isGraphVisible) {
    try {
      // Load recent points used to seed each server's mini chart
      priorHistory = await history.getWindow(nowMs - config.serverGraphDuration, nowMs)
      records = await history.getAllRecords()
      peaks = await history.getAllPeaks()
    } catch (err) {
      // A storage failure must not prevent the page from loading
      priorHistory = null
      records = null
      peaks = null
      isGraphVisible = false
    }
  }

  const payload = {
    message: 'init',
    config: buildConfig(servers, isGraphVisible),
    timestampPoints: priorHistory ? priorHistory.timestamps.map(timestamp => Math.floor(timestamp / 1000)) : [],
    servers: buildInitServers(servers, priorHistory, records, peaks)
  }

  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=60')
  res.end(JSON.stringify(payload))
}