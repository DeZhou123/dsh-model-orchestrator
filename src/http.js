/**
 * The panel's data and control surface.
 *
 * The Host serves it over `webServer` because that is what this profile's other
 * panels do (`our-free-model`, `dsh-api-dashboard`) and because the kernel's
 * Remote/typert plumbing would pin the plugin to one kernel generation. The
 * routes are fenced exactly like theirs: the kernel's own connection service
 * decides admission, and a plugin route that skipped that check would be
 * reachable from any loopback caller without the page's session cookie.
 *
 * @module src/http
 */

const PREFIX = '/api/model-orchestrator'

/** Read a JSON request body with a hard size cap. */
async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Install the routes.
 *
 * @param {object} options
 * @param {object} options.ctx - host context carrying `webServer` (and `connection` when present).
 * @param {object} options.api - the orchestrator's read/write face.
 * @returns {() => void} disposer
 */
export function installHttpApi(options) {
  const { ctx, api } = options

  let connection = null
  // A nested inject: `ctx.get('connection')` on the plugin's own fiber answers
  // undefined in this composition, and turning that race into "allow" is how a
  // fence becomes a bypass.
  ctx.inject(['connection'], (scoped) => {
    connection = scoped.connection
    return () => {
      connection = null
    }
  })

  const allow = (req, res) => {
    let rejection = 503
    if (connection !== null && typeof connection.requestRejection === 'function') {
      try {
        rejection = connection.requestRejection(req)
      } catch {
        rejection = 503
      }
    }
    if (rejection === undefined) return true
    res.writeHead(rejection, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(rejection === 401 ? 'dsh web authentication required; reopen the URL printed by dsh web.\n' : 'forbidden\n')
    return false
  }

  const sendJson = (res, code, value) => {
    const body = JSON.stringify(value)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  const routes = [
    {
      path: `${PREFIX}/summary`,
      async handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const value = api.summary(sessionId === '' ? null : sessionId)
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-transform' })
          res.end()
          return
        }
        sendJson(res, 200, value)
      },
    },
    {
      path: `${PREFIX}/families`,
      async handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const query = url.searchParams.get('q') ?? ''
        const value = api.families(sessionId === '' ? null : sessionId, query)
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-transform' })
          res.end()
          return
        }
        sendJson(res, 200, value)
      },
    },
    {
      path: `${PREFIX}/config`,
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        try {
          const patch = await readJsonBody(req)
          sendJson(res, 200, { ok: true, config: api.applyConfig(patch) })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: `${PREFIX}/refresh`,
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        try {
          const catalog = await api.refresh()
          sendJson(res, 200, { ok: true, catalog })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]

  // One independent fiber: a composition without a web server must leave the
  // routing lane untouched rather than pend this plugin forever.
  ctx.inject(['webServer'], (scoped) => {
    for (const route of routes) {
      scoped.effect(
        () => scoped.webServer.register({
          kind: 'exact',
          path: route.path,
          handler: (req, res) => {
            if (!allow(req, res)) return
            return route.handler(req, res)
          },
        }),
        `model-orchestrator: ${route.path}`,
      )
    }
  })
}

export default installHttpApi
