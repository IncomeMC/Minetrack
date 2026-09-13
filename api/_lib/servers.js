const config = require('../../config.json')
const serversData = require('../../servers.json')
const minecraftVersions = require('../../minecraft_versions.json')

function assignColor (server) {
  if (server.color) {
    return
  }

  let hash = 0
  for (let i = server.name.length - 1; i >= 0; i--) {
    hash = server.name.charCodeAt(i) + ((hash << 5) - hash)
  }

  const color = Math.floor(Math.abs((Math.sin(hash) * 10000) % 1 * 16777216)).toString(16)
  server.color = '#' + Array(6 - color.length + 1).join('0') + color
}

// Returns a deep copy of servers.json with generated colors assigned
function getServers () {
  const servers = JSON.parse(JSON.stringify(serversData))

  servers.forEach(assignColor)

  return servers
}

function getConfig () {
  return config
}

function getMinecraftVersions () {
  return minecraftVersions
}

module.exports = {
  getConfig,
  getMinecraftVersions,
  getServers
}