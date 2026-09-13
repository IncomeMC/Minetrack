const dns = require('dns')

const { getConfig } = require('./servers')

const config = getConfig()

const SKIP_SRV_TIMEOUT = config.skipSrvTimeout || 60 * 60 * 1000

// Vercel functions are request based and cannot reliably retain per-instance
// state between invocations, but a warm instance may serve several requests.
// Cache SRV resolution misses for the lifetime of the instance to avoid
// repeating DNS lookups on every poll.
const srvMissCache = new Map() // ip -> skipUntil timestamp

function isSrvSkipActive (ip) {
  const skipUntil = srvMissCache.get(ip)

  return skipUntil && Date.now() <= skipUntil
}

// Resolves the _minecraft._tcp SRV record for a Java Edition server address.
// Always resolves within `timeout` ms so an unresponsive DNS resolver cannot
// hang the containing Vercel function past its budget.
function resolveJavaAddress (ip, port, timeout) {
  return new Promise(resolve => {
    const fire = (host, resolvedPort) => {
      resolve({
        host: host || ip,
        port: resolvedPort || port || 25565
      })
    }

    if (isSrvSkipActive(ip)) {
      fire()

      return
    }

    let callbackFired = false

    const fireCallback = (host, resolvedPort) => {
      if (!callbackFired) {
        callbackFired = true

        clearTimeout(timeoutHandle)

        fire(host, resolvedPort)
      }
    }

    const timeoutHandle = setTimeout(fireCallback, timeout)

    dns.resolveSrv('_minecraft._tcp.' + ip, (err, records) => {
      const isMiss = (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA')) || !records || records.length === 0

      if (isMiss) {
        const isSkipDisabled = typeof config.skipSrvTimeout === 'number' && config.skipSrvTimeout === 0

        if (!isSrvSkipActive(ip) && !isSkipDisabled) {
          srvMissCache.set(ip, Date.now() + SKIP_SRV_TIMEOUT)
        }

        fireCallback()
      } else {
        fireCallback(records[0].name, records[0].port)
      }
    })
  })
}

module.exports = {
  resolveJavaAddress
}