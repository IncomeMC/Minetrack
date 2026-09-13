const minecraftJavaPing = require('mcping-js')
const minecraftBedrockPing = require('mcpe-ping-fixed')

const { resolveJavaAddress } = require('./dns')
const { getConfig, getMinecraftVersions } = require('./servers')

const config = getConfig()

const MAX_PLAYER_COUNT = 250000
const SAFETY_TIMEOUT_MARGIN = 500

// Selects the protocol version probe based on the current wall clock.
// Vercel functions are stateless, so the probe rotates over time using the
// configured pingAll rate instead of an in-memory counter. This mirrors the
// original backend's behavior of cycling through known protocol versions.
function getNextProtocolVersion () {
  const protocolVersions = getMinecraftVersions().PC

  if (!protocolVersions || protocolVersions.length === 0) {
    return null
  }

  const protocolIndex = Math.floor(Date.now() / config.rates.pingAll) % protocolVersions.length

  return {
    protocolId: protocolVersions[protocolIndex].protocolId,
    protocolIndex
  }
}

// Player count can be up to 2^32-1, which is a massive scale and destroys
// browser performance when rendering graphs. Artificially cap to prevent
// propagating garbage to the frontend.
function capPlayerCount (host, playerCount) {
  if (typeof playerCount !== 'number' || isNaN(playerCount)) {
    return 0
  }

  if (playerCount !== Math.min(playerCount, MAX_PLAYER_COUNT)) {
    console.log('[warn] %s returned a player count of %d, capped to %d.', host, playerCount, MAX_PLAYER_COUNT)

    return MAX_PLAYER_COUNT
  } else if (playerCount !== Math.max(playerCount, 0)) {
    console.log('[warn] %s returned an invalid player count of %d, setting to 0.', host, playerCount)

    return 0
  }

  return playerCount
}

function pingJava (host, port, timeout, protocolId) {
  return new Promise(resolve => {
    let finished = false

    const finish = result => {
      if (!finished) {
        finished = true

        clearTimeout(safetyTimeout)

        resolve(result)
      }
    }

    const server = new minecraftJavaPing.MinecraftServer(host, port || 25565)

    const safetyTimeout = setTimeout(() => {
      finish({ err: new Error('Ping timed out') })
    }, timeout + SAFETY_TIMEOUT_MARGIN)

    server.ping(timeout, protocolId, (err, res) => {
      if (err) {
        finish({ err })
      } else {
        const payload = {
          players: {
            online: capPlayerCount(host, parseInt(res.players.online))
          },
          version: parseInt(res.version.protocol)
        }

        // Ensure the returned favicon is a data URI
        if (res.favicon && res.favicon.startsWith('data:image/')) {
          payload.favicon = res.favicon
        }

        finish({ resp: payload })
      }
    })
  })
}

function pingBedrock (ip, port, timeout) {
  return new Promise(resolve => {
    let finished = false

    const finish = result => {
      if (!finished) {
        finished = true

        clearTimeout(safetyTimeout)

        resolve(result)
      }
    }

    const safetyTimeout = setTimeout(() => {
      finish({ err: new Error('Ping timed out') })
    }, timeout + SAFETY_TIMEOUT_MARGIN)

    minecraftBedrockPing(ip, port || 19132, (err, res) => {
      if (err) {
        finish({ err })
      } else {
        finish({
          resp: {
            players: {
              online: capPlayerCount(ip, parseInt(res.currentPlayers))
            }
          }
        })
      }
    }, timeout)
  })
}

// Pings every configured server exactly once, in parallel.
// Each ping is independently bounded by `timeout` so a single unresponsive
// server cannot prevent the others from resolving or hold the function open.
async function pingAll (servers, timeout) {
  const results = []

  await Promise.all(servers.map(async (server, serverId) => {
    try {
      if (server.type === 'PC') {
        const protocolVersion = getNextProtocolVersion()
        const { host, port } = await resolveJavaAddress(server.ip, server.port, timeout)

        results[serverId] = protocolVersion
          ? await pingJava(host, port, timeout, protocolVersion.protocolId)
          : { err: new Error('No protocol versions configured') }
      } else if (server.type === 'PE') {
        results[serverId] = await pingBedrock(server.ip, server.port, timeout)
      } else {
        results[serverId] = { err: new Error('Unsupported type: ' + server.type) }
      }
    } catch (err) {
      results[serverId] = { err }
    }
  }))

  return results
}

module.exports = {
  capPlayerCount,
  pingAll
}