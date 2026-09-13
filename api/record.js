const { getConfig, getServers } = require('./_lib/servers')
const history = require('./_lib/history')
const { pingAll } = require('./_lib/ping')
const { applyRecordUpdates } = require('./_lib/history')
const { getPlayerCountOrNull } = require('./_lib/updates')

// GET /api/record
// Pings every configured server once and records a single historical point for
// the current minute into Vercel KV.
//
// This endpoint is deliberately request based and performs one bounded round of
// pings per invocation. It is called automatically by the frontend's live poll
// (rate limited to once per minute for each minute) so historical tracking
// continues while visitors are viewing the page.
//
// For uninterrupted 24/7 coverage between visitors, add a Vercel Cron Job
// targeting this path on a Pro plan:
//
//   "crons": [
//     { "path": "/api/record", "schedule": "*/1 * * * *" }
//   ]
//
// (The Hobby plan only supports daily cron schedules, which would leave large
// gaps, so no cron is configured by default.)
module.exports = async (req, res) => {
  const config = getConfig()
  const servers = getServers()

  let recorded = false

  if (history.configured()) {
    const results = await pingAll(servers, config.rates.connectTimeout)

    const nowMs = Date.now()
    const counts = servers.map((server, serverId) => getPlayerCountOrNull(results[serverId].resp))

    await applyRecordUpdates(servers, counts, nowMs)
    recorded = await history.recordPoint(servers, counts, nowMs)
  }

  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({
    ok: true,
    recorded
  }))
}