/**
 * 渠道互借 · 借用方：把对侧的一条 provider 变成自己的普通 provider。
 *
 * 本机注册一条 provider 路由（默认名 peer），下面挂对侧愿意出借的每个 provider/model，
 * 每个都是一个 model id（就是 'provider/model' 这个字符串）。于是模型选择器、目录刷新、
 * 路由打分、健康账本全部照旧工作 —— 借来的车道在系统里就是一条车道。
 *
 * 注意：model id 本身可能带 /（opencode/deepseek-v4.1-flash），所以不要按 / 切分还原
 * 对端路由，一律走 listModels 时建立的映射表。
 *
 * 图片不过界：图片块引用的是本机附件 id，对侧读不到。本适配器因此不声明 image 模态
 * （路由层不会把带图请求派过来），真收到图片块时明确报错，而不是静默降级。
 *
 * @module src/peershare-adapter
 */

import http from 'node:http'
import { PEERSHARE_PROTOCOL } from './peershare.js'

const IDLE_TIMEOUT_MS = 120_000
const LIST_TIMEOUT_MS = 15_000

function peerError(payload) {
  const error = new Error(String(payload?.message ?? 'peershare 上游失败'))
  error.code = String(payload?.code ?? 'PEERSHARE_UPSTREAM')
  if (Number.isFinite(Number(payload?.status))) error.status = Number(payload.status)
  return error
}

export function normalizePeerUrl(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  return text.replace(/\/+$/, '')
}

function getJson(url, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error('对侧地址不合法：' + url))
      return
    }
    const request = http.request({
      host: target.hostname,
      port: target.port === '' ? 80 : Number(target.port),
      path: target.pathname + target.search,
      method: 'GET',
      // 不带 hop 头：本适配器是中继链的**起点**，不是转发方。带了就等于自报「已被中继」，
      // 出借方的回环守卫会（正确地）508 拒绝。
      headers: { authorization: 'Bearer ' + token },
    }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: response.statusCode ?? 0, body: text === '' ? {} : JSON.parse(text) })
        } catch {
          reject(new Error('对侧返回的不是 JSON（HTTP ' + response.statusCode + '）'))
        }
      })
    })
    const timer = setTimeout(() => request.destroy(new Error('对侧超时 ' + timeoutMs + 'ms')), timeoutMs)
    timer.unref?.()
    request.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    request.on('close', () => clearTimeout(timer))
    request.end()
  })
}

function serializableOptions(options) {
  const out = {}
  for (const [key, value] of Object.entries(options ?? {})) {
    if (key === 'signal' || key === 'provider' || key === 'model' || key === 'sessionId') continue
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

function hasImage(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'image') return true
    }
  }
  return false
}

export function createPeerAdapter(options) {
  const provider = String(options.provider ?? 'peer')
  const config = typeof options.config === 'function' ? options.config : () => ({})
  const log = typeof options.log === 'function' ? options.log : () => {}

  let models = []
  let modelsAt = 0
  let modelsError = ''

  const baseUrl = () => normalizePeerUrl(config().peerUrl)
  const token = () => String(config().peerToken ?? '').trim()

  async function refreshModels() {
    const base = baseUrl()
    if (base === '') {
      modelsError = '未配置 peerUrl'
      return models
    }
    try {
      const response = await getJson(base + '/peershare/v1/models', token(), Number(config().timeoutMs ?? LIST_TIMEOUT_MS))
      if (response.status !== 200) {
        modelsError = '对侧 HTTP ' + response.status + '：' + String(response.body?.error?.message ?? '')
        return models
      }
      const list = Array.isArray(response.body?.models) ? response.body.models : []
      models = list
        .filter(row => typeof row?.provider === 'string' && row.provider !== '' && typeof row?.model === 'string' && row.model !== '')
        .map(row => ({ ...row, id: String(row.id ?? (row.provider + '/' + row.model)) }))
      modelsAt = Date.now()
      modelsError = ''
    } catch (error) {
      modelsError = error instanceof Error ? error.message : String(error)
      log('拉取对侧出借清单失败：' + modelsError)
    }
    return models
  }

  const findRemote = (model) => models.find(row => row.id === model) ?? null

  const adapter = {
    providerInfo(id) {
      return { id, name: String(config().label ?? '') || '对侧渠道（互借）' }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    async listModels(id) {
      if (id !== provider) return []
      const rows = await refreshModels()
      return rows.map(row => ({
        provider,
        id: row.id,
        name: row.name ?? row.model,
        inputModalities: ['text'],
      }))
    },
    async resolveModel(id, model) {
      if (id !== provider) throw peerError({ code: 'NO_ADAPTER', message: '不属于本适配器：' + id })
      if (models.length === 0) await refreshModels()
      const remote = findRemote(model)
      if (remote === null) throw peerError({ code: 'UNKNOWN_MODEL', message: '对侧不再出借 ' + model })
      return {
        provider,
        id: model,
        name: remote.name ?? remote.model,
        inputModalities: ['text'],
        ...(Number.isFinite(remote.contextWindow) && remote.contextWindow > 0
          ? { context: { contextWindow: remote.contextWindow } }
          : {}),
      }
    },
    async prepareCall(id, model, signal) {
      const info = await adapter.resolveModel(id, model, signal)
      return { model: info, stream: (request) => adapter.stream(request) }
    },
    async *stream(request) {
      const remote = findRemote(request?.model)
      if (remote === null) throw peerError({ code: 'UNKNOWN_MODEL', message: '对侧不再出借 ' + String(request?.model ?? '') })
      if (hasImage(request?.messages)) throw peerError({ code: 'UNSUPPORTED_CONTENT', message: '图片不能跨实例借用（附件 id 只在本机有效）' })
      const base = baseUrl()
      if (base === '') throw peerError({ code: 'NO_PEER', message: '未配置 peerUrl' })
      const payload = JSON.stringify({
        protocol: PEERSHARE_PROTOCOL,
        provider: remote.provider,
        model: remote.model,
        options: serializableOptions(request),
      })
      const target = new URL(base + '/peershare/v1/stream')
      const body = await new Promise((resolve, reject) => {
        const client = http.request({
          host: target.hostname,
          port: target.port === '' ? 80 : Number(target.port),
          path: target.pathname + target.search,
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
            authorization: 'Bearer ' + token(),
          },
        }, resolve)
        client.on('error', reject)
        const abort = () => client.destroy(new Error('peershare 调用被取消'))
        if (request?.signal?.aborted === true) {
          abort()
          return
        }
        request?.signal?.addEventListener?.('abort', abort, { once: true })
        client.end(payload)
      })
      if (body.statusCode !== 200) {
        const chunks = []
        for await (const chunk of body) chunks.push(chunk)
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = null
        }
        throw peerError({
          code: String(parsed?.error?.code ?? ('PEERSHARE_HTTP_' + body.statusCode)),
          status: body.statusCode,
          message: String(parsed?.error?.message ?? text.slice(0, 300)),
        })
      }
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      let finished = false
      const idle = new Set()
      const armIdle = () => {
        const timer = setTimeout(() => body.destroy(new Error('对侧长时间没有推送数据')), IDLE_TIMEOUT_MS)
        timer.unref?.()
        idle.add(timer)
      }
      const disarmIdle = () => {
        for (const timer of idle) clearTimeout(timer)
        idle.clear()
      }
      armIdle()
      try {
        for await (const chunk of body) {
          disarmIdle()
          armIdle()
          buffer += decoder.decode(chunk, { stream: true })
          let index = buffer.indexOf('\n')
          while (index >= 0) {
            const line = buffer.slice(0, index).trim()
            buffer = buffer.slice(index + 1)
            index = buffer.indexOf('\n')
            if (line === '') continue
            let event
            try {
              event = JSON.parse(line)
            } catch {
              continue
            }
            if (event?.type === 'chunk') {
              yield event.chunk
              continue
            }
            if (event?.type === 'error') throw peerError(event.error)
            if (event?.type === 'end') {
              finished = true
              return
            }
          }
        }
        if (!finished) throw peerError({ code: 'PEERSHARE_TRUNCATED', message: '对侧连接提前结束，没有收到结束标记' })
      } finally {
        disarmIdle()
      }
    },
  }

  return {
    provider,
    adapter,
    refreshModels,
    get models() {
      return models
    },
    get modelsAt() {
      return modelsAt
    },
    get modelsError() {
      return modelsError
    },
  }
}

export default createPeerAdapter
