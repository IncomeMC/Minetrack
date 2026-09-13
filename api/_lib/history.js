const { getConfig } = require('./servers')

const config = getConfig()

const POINTS_KEY = 'minetrack:points'
const TIMESTAMPS_KEY = 'minetrack:timestamps'
const RECORDS_KEY = 'minetrack:records'
const PEAKS_KEY = 'minetrack:peaks'

const GRAPH_STEP_MS = 60 * 1000

// Vercel KV (Upstash Redis) is accessed through its plain REST interface using
// the built-in fetch API. This deliberately avoids adding an npm dependency.
//
// Vercel KV is deprecated, so both the legacy KV_* variables and the current
// UPSTASH_REDIS_* variables injected by the Upstash Redis integration are
// supported.
function kvRestUrl () {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
}

function kvRestToken () {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
}

function configured () {
  return !!(kvRestUrl() && kvRestToken())
}

async function request (url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + kvRestToken()
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    throw new Error('Vercel KV request failed with status ' + response.status)
  }

  return response.json()
}

async function command (command, ...args) {
  if (!configured()) {
    throw new Error('Vercel KV is not configured')
  }

  const json = await request(kvRestUrl(), [command, ...args])

  if (json.error) {
    throw new Error(json.error)
  }

  return json.result
}

async function pipeline (commands) {
  if (!configured()) {
    throw new Error('Vercel KV is not configured')
  }

  const json = await request(kvRestUrl() + '/pipeline', commands.map(({ command, args }) => [command, ...args]))

  return json.map(item => {
    if (item.error) {
      throw new Error(item.error)
    }

    return item.result
  })
}

function getMinuteMs (timestamp) {
  return Math.floor(timestamp / GRAPH_STEP_MS) * GRAPH_STEP_MS
}

function parseHash (flat) {
  const parsed = {}

  if (!flat) {
    return parsed
  }

  for (let i = 0; i < flat.length; i += 2) {
    try {
      parsed[flat[i]] = JSON.parse(flat[i + 1])
    } catch (err) {
      parsed[flat[i]] = null
    }
  }

  return parsed
}

// Reads all historical points within [startMs, endMs].
// Returns timestamps (ms) and an equally sized list of per-server count arrays
// aligned with the servers.json ordering. A null entry means no point existed.
async function getWindow (startMs, endMs) {
  const members = await command('ZRANGEBYSCORE', TIMESTAMPS_KEY, String(startMs), String(endMs))

  if (!members || members.length === 0) {
    return {
      timestamps: [],
      data: []
    }
  }

  const values = await command('HMGET', POINTS_KEY, ...members)

  return {
    timestamps: members.map(Number),
    data: values.map(value => {
      if (!value) {
        return null
      }

      try {
        return JSON.parse(value)
      } catch (err) {
        return null
      }
    })
  }
}

// Records the player counts for the current minute (rate limited to a single
// point per minute through HSETNX). Returns true when a new point was created,
// which is used by the frontend to append to the historical graph.
async function recordPoint (servers, counts, timestamp) {
  const nowMs = timestamp || Date.now()
  const minuteMs = getMinuteMs(nowMs)

  const created = await command('HSETNX', POINTS_KEY, String(minuteMs), JSON.stringify(counts))

  if (created === 1) {
    await pipeline([
      { command: 'ZADD', args: [TIMESTAMPS_KEY, String(minuteMs), String(minuteMs)] }
    ])

    await pruneOldPoints(nowMs)

    // Recompute graph peaks on each new point so the dashboard peak value
    // matches the rolling graph window
    await recomputePeaks(servers)
  }

  return created === 1
}

async function pruneOldPoints (nowMs) {
  const oldest = nowMs - config.graphDuration
  const stale = await command('ZRANGEBYSCORE', TIMESTAMPS_KEY, '-inf', String(oldest))

  if (!stale || stale.length === 0) {
    return
  }

  await pipeline([
    { command: 'ZREM', args: [TIMESTAMPS_KEY, ...stale] },
    { command: 'HDEL', args: [POINTS_KEY, ...stale] }
  ])
}

async function recomputePeaks (servers) {
  const nowMs = Date.now()
  const { timestamps, data } = await getWindow(nowMs - config.graphDuration, nowMs)
  const peaks = servers.map(() => null)

  for (let i = 0; i < data.length; i++) {
    const counts = data[i]

    if (!counts) {
      continue
    }

    for (let serverId = 0; serverId < servers.length; serverId++) {
      const count = counts[serverId]

      if (typeof count !== 'number') {
        continue
      }

      const current = peaks[serverId]

      if (!current || count > current.playerCount) {
        peaks[serverId] = {
          playerCount: count,
          timestamp: Math.floor(timestamps[i] / 1000)
        }
      }
    }
  }

  const fields = []

  peaks.forEach((peak, serverId) => {
    fields.push(servers[serverId].ip, JSON.stringify(peak || { playerCount: null, timestamp: null }))
  })

  await command('HSET', PEAKS_KEY, ...fields)
}

// Returns all tracked all-time records as ip -> { playerCount, timestamp }
async function getAllRecords () {
  const flat = await command('HGETALL', RECORDS_KEY)

  return parseHash(flat)
}

// Returns all tracked graph peaks as ip -> { playerCount, timestamp }
async function getAllPeaks () {
  const flat = await command('HGETALL', PEAKS_KEY)

  return parseHash(flat)
}

// Compares the live player counts against the stored all-time records and
// writes any new records. Returns an array of { ip, recordData } for servers
// that set a new record during this call.
async function applyRecordUpdates (servers, counts, timestamp) {
  const records = await getAllRecords()
  const writes = []
  const updates = []

  const timestampSeconds = Math.floor(timestamp / 1000)

  for (let serverId = 0; serverId < servers.length; serverId++) {
    const server = servers[serverId]
    const count = counts[serverId]

    if (typeof count !== 'number') {
      continue
    }

    const existing = records[server.ip]

    if (!existing || count > existing.playerCount) {
      const recordData = {
        playerCount: count,
        timestamp: timestampSeconds
      }

      writes.push(server.ip, JSON.stringify(recordData))
      updates.push({ ip: server.ip, recordData })
    }
  }

  if (writes.length > 0) {
    await command('HSET', RECORDS_KEY, ...writes)
  }

  return updates
}

module.exports = {
  applyRecordUpdates,
  configured,
  getAllPeaks,
  getAllRecords,
  getWindow,
  recordPoint
}