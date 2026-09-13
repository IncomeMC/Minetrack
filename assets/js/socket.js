const MAX_POLL_INTERVAL_MILLISECONDS = 20000
const MIN_POLL_INTERVAL_MILLISECONDS = 3000
const MAX_CONSECUTIVE_FAILURES = 2

export class SocketManager {
  constructor (app) {
    this._app = app
    this._hasRequestedHistoryGraph = false
    this._reconnectDelayBase = 0
    this._consecutiveFailures = 0
    this._isRequestInFlight = false
  }

  reset () {
    this._hasRequestedHistoryGraph = false

    // Release any active polling tasks and references
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = undefined
    }

    this._isRequestInFlight = false
  }

  // Replaces the WebSocket handshake: fetches the initial state payload
  initialize () {
    this._app.caption.set('Loading...')

    // Refresh immediately on visibility changes so the page never
    // displays stale data after being backgrounded
    document.addEventListener('visibilitychange', this.handleVisibilityChange, false)

    this.fetchInit()
  }

  handleVisibilityChange = () => {
    if (!document.hidden) {
      this.fetchServers()
    }
  }

  async fetchInit () {
    try {
      const response = await fetch('/api/init')

      if (!response.ok) {
        throw new Error('Init request failed')
      }

      const payload = await response.json()

      this._consecutiveFailures = 0
      this._reconnectDelayBase = 0

      this.handleMessage(payload)

      this.startPolling()
    } catch (err) {
      // A failed init fetch has no polling task backing it up, so escalate
      // straight to the reconnect flow to schedule a retry
      this.handleRequestFailure()
    }
  }

  startPolling () {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
    }

    const configuredInterval = this._app.publicConfig.rates
      ? this._app.publicConfig.rates.pingAll
      : MIN_POLL_INTERVAL_MILLISECONDS

    // Clamp the poll rate to something reasonable for a serverless backend
    const pollInterval = Math.min(Math.max(configuredInterval, MIN_POLL_INTERVAL_MILLISECONDS), MAX_POLL_INTERVAL_MILLISECONDS)

    this._pollTimer = setInterval(this.fetchServers, pollInterval)
  }

  fetchServers = async () => {
    // Guard against overlapping requests if a poll takes longer than the interval
    if (this._isRequestInFlight) {
      return
    }

    // Defer requests while the tab is hidden to avoid burning function invocations
    if (document.hidden) {
      return
    }

    this._isRequestInFlight = true

    try {
      const response = await fetch('/api/servers')

      if (!response.ok) {
        throw new Error('Servers request failed')
      }

      const payload = await response.json()

      this._consecutiveFailures = 0

      this.handleMessage(payload)
    } catch (err) {
      this.handleRequestFailure()
    } finally {
      this._isRequestInFlight = false
    }
  }

  fetchHistoryGraph () {
    if (this._hasRequestedHistoryGraph) {
      return
    }

    this._hasRequestedHistoryGraph = true

    fetch('/api/historyGraph')
      .then(response => response.json())
      .then(payload => this.handleMessage(payload))
      .catch(() => {
        // Allow a later retry if the history graph failed to load
        this._hasRequestedHistoryGraph = false
      })
  }

  handleRequestFailure () {
    this._consecutiveFailures++

    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES || !this._pollTimer) {
      // Reset all application state to mirror a dropped connection
      this._app.handleDisconnect()

      this.scheduleReconnect()
    }
  }

  scheduleReconnect () {
    this._app.caption.set('Lost connection!')

    this._reconnectDelayBase++

    // Exponential backoff for reconnection attempts
    // Clamp ceiling value to 30 seconds
    let reconnectDelaySeconds = Math.min((this._reconnectDelayBase * this._reconnectDelayBase), 30)

    const reconnectInterval = setInterval(() => {
      reconnectDelaySeconds--

      if (reconnectDelaySeconds === 0) {
        clearInterval(reconnectInterval)

        this._app.caption.set('Reconnecting...')

        this.initialize()
      } else if (reconnectDelaySeconds > 0) {
        this._app.caption.set(`Reconnecting in ${reconnectDelaySeconds}s...`)
      }
    }, 1000)
  }

  // Routes API responses through the same message handlers the original
  // WebSocket implementation used
  handleMessage (payload) {
    switch (payload.message) {
      case 'init':
        this._app.setPublicConfig(payload.config)

        // Display the main page component
        // Called here instead of syncComplete so the DOM can be drawn prior to the graphs being drawn
        this._app.setPageReady(true)

        // Allow the graphDisplayManager to control whether or not the historical graph is loaded
        // Defer to isGraphVisible from the publicConfig to understand if the frontend will ever receive a graph payload
        if (this._app.publicConfig.isGraphVisible) {
          this.fetchHistoryGraph()
        }

        payload.servers.forEach((serverPayload, serverId) => {
          this._app.addServer(serverId, serverPayload, payload.timestampPoints)
        })

        // Init payload contains all data needed to render the page
        // Alert the app it is ready
        this._app.handleSyncComplete()

        break

      case 'updateServers': {
        for (let serverId = 0; serverId < payload.updates.length; serverId++) {
          // The backend may send "update" events prior to receiving all "add" events
          // A server has only been added once it's ServerRegistration is defined
          // Checking undefined protects from this race condition
          const serverRegistration = this._app.serverRegistry.getServerRegistration(serverId)
          const serverUpdate = payload.updates[serverId]

          if (serverRegistration) {
            serverRegistration.handlePing(serverUpdate, payload.timestamp)
            serverRegistration.updateServerStatus(serverUpdate, this._app.publicConfig.minecraftVersions)
          }
        }

        // Bulk add playerCounts into graph during #updateHistoryGraph
        if (payload.updateHistoryGraph) {
          this._app.graphDisplayManager.addGraphPoint(payload.timestamp, Object.values(payload.updates).map(update => update.playerCount))

          // Run redraw tasks after handling bulk updates
          this._app.graphDisplayManager.redraw()
        }

        this._app.percentageBar.redraw()
        this._app.updateGlobalStats()

        break
      }

      case 'historyGraph': {
        this._app.graphDisplayManager.buildPlotInstance(payload.timestamps, payload.graphData)

        // Build checkbox elements for graph controls
        let lastRowCounter = 0
        let controlsHTML = ''

        this._app.serverRegistry.getServerRegistrations()
          .map(serverRegistration => serverRegistration.data.name)
          .sort()
          .forEach(serverName => {
            const serverRegistration = this._app.serverRegistry.getServerRegistration(serverName)

            controlsHTML += `<td><label>
              <input type="checkbox" class="graph-control" minetrack-server-id="${serverRegistration.serverId}" ${serverRegistration.isVisible ? 'checked' : ''}>
              ${serverName}
              </label></td>`

            // Occasionally break table rows using a magic number
            if (++lastRowCounter % 6 === 0) {
              controlsHTML += '</tr><tr>'
            }
          })

        // Apply generated HTML and show controls
        document.getElementById('big-graph-checkboxes').innerHTML = `<table><tr>${controlsHTML}</tr></table>`
        document.getElementById('big-graph-controls').style.display = 'block'

        // Bind click event for updating graph data
        this._app.graphDisplayManager.initEventListeners()
        break
      }
    }
  }
}
