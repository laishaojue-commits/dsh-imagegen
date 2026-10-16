import { setTimeout as delay } from 'node:timers/promises'

export class ImageGenerationError extends Error {
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`)
    this.name = 'ImageGenerationError'
    this.code = code
    Object.assign(this, details)
  }
}

export function selectModel(requested, configured, allowOverride = false) {
  const model = requested === undefined ? configured : requested.trim()
  if (!model) throw new ImageGenerationError('IMAGE_CONFIG', '生图模型未配置。请在插件设置中填写默认生图模型。')
  if (!allowOverride && model !== configured) {
    throw new ImageGenerationError('IMAGE_MODEL_LOCKED', `当前仅允许配置的生图模型 ${configured}。请使用默认模型；更换模型需要用户修改插件设置，不要尝试聊天模型或扫描其他模型。`)
  }
  return model
}

function duration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined
  if (typeof value !== 'string') return undefined
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/gi)]
  if (!parts.length) return undefined
  return parts.reduce((total, [, count, unit]) => total + Number(count) * ({ h: 3600, m: 60, s: 1 })[unit.toLowerCase()], 0)
}

// Prefer current machine-readable reset data. A stored last_upstream_error
// often contains an OLD "9m32s" message and is not a live countdown.
export function retryAfterSeconds(headers, payload, now = Date.now()) {
  const candidates = []
  const header = headers.get('retry-after')
  if (header !== null) {
    const seconds = duration(header)
    const date = Date.parse(header)
    if (seconds !== undefined) candidates.push(seconds)
    else if (Number.isFinite(date)) candidates.push(Math.max(0, (date - now) / 1000))
  }
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return
    for (const [key, child] of Object.entries(value)) {
      if (/last[_-]?(?:upstream[_-]?)?error|history/i.test(key)) continue
      if (/^(?:reset_seconds|retry_after_seconds|retry_after|retryDelay|quotaResetDelay)$/i.test(key)) {
        const seconds = duration(child && typeof child === 'object' ? child.seconds : child)
        if (seconds !== undefined) candidates.push(seconds)
      } else if (/^reset_time$/i.test(key) && typeof child === 'string') {
        const seconds = duration(child)
        if (seconds !== undefined) candidates.push(seconds)
      }
      if (typeof child === 'object') visit(child, depth + 1)
    }
  }
  visit(payload)
  if (candidates.length) return Math.ceil(Math.max(...candidates))
  const message = payload?.error?.message ?? payload?.message
  if (typeof message === 'string' && !/last (?:upstream )?error/i.test(message)) {
    const match = message.match(/(?:reset|retry|available)\s+(?:after|in)\s+((?:\d+(?:\.\d+)?\s*[hms]\s*)+)/i)
    if (match) return Math.ceil(duration(match[1]))
  }
  return undefined
}

export function redactMessage(message, secrets = []) {
  let text = String(message ?? '')
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[REDACTED]')
  return text.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[IMAGE DATA]')
    .slice(0, 240)
}

export function noImageError(protocol) {
  return new ImageGenerationError('IMAGE_NO_IMAGE', `${protocol} 接口返回了响应，但没有可用图片。这不是额度冷却；请向用户说明返回无图片，停止自动换模型和系统排查。`)
}

function cooldownError(model, until, now, unknown = false) {
  const seconds = Math.max(1, Math.ceil((until - now) / 1000))
  return new ImageGenerationError('IMAGE_COOLDOWN',
    `生图模型 ${model} 当前限流或额度冷却。${unknown ? '上游未给出恢复时间，建议至少等待' : '约需等待'} ${seconds} 秒；retry_after_seconds=${seconds}。请向用户说明并结束本轮，不要换模型、运行探测命令或连续重试。`,
    { retryAfterSeconds: seconds, retryAt: new Date(until).toISOString() })
}

function abortError(signal) {
  return signal?.reason?.name === 'TimeoutError'
    ? new ImageGenerationError('IMAGE_TIMEOUT', '生图已达到总耗时上限，停止重试。')
    : new ImageGenerationError('IMAGE_CANCELLED', '生图请求或等待已取消。')
}

export function createRequestPolicy({ fetchImpl = globalThis.fetch, now = Date.now,
  sleep = (ms, signal) => delay(ms, undefined, { signal }), onEvent = () => {} } = {}) {
  const cooldowns = new Map()
  const emit = (event) => { try { onEvent(event) } catch { /* logging cannot break a generation */ } }
    async function request({ endpoint, model, headers, body, signal, timeoutMs = 180000,
      requestTimeoutMs = 90000, maxCooldownWaitMs = 60000, maxRetries = 1 }) {
      const started = now()
      // Internal only: credentials distinguish independent quota pools. Never log this key.
      const key = JSON.stringify([endpoint, model, headers.Authorization ?? headers['x-goog-api-key'] ?? headers])
      for (const [storedKey, value] of cooldowns) if (value.until <= now()) cooldowns.delete(storedKey)
      const secrets = Object.entries(headers).filter(([name]) => !['content-type', 'user-agent'].includes(name.toLowerCase())).map(([, value]) => value)
      secrets.push(...secrets.map((value) => String(value).replace(/^Bearer\s+/i, '')))
      let waitedMs = 0
      let attempts = 0
      async function waitFor(entry) {
        const waitMs = Math.max(0, entry.until - now())
        // Preserve a full request window, and never silently wait for minutes.
        const budget = timeoutMs - (now() - started)
        if (waitedMs + waitMs > maxCooldownWaitMs || waitMs + requestTimeoutMs > budget) {
          emit({ event: 'cooldown', model, retry_after_seconds: Math.ceil(waitMs / 1000) })
          throw cooldownError(model, entry.until, now(), entry.unknown)
        }
        emit({ event: 'waiting', model, wait_ms: waitMs })
        try { await sleep(waitMs, signal) } catch (error) {
          if (signal?.aborted) throw abortError(signal)
          throw error
        }
        waitedMs += waitMs
      }
      const cached = cooldowns.get(key)
      if (cached) await waitFor(cached)
      while (true) {
        if (signal?.aborted) throw abortError(signal)
        const remaining = timeoutMs - (now() - started)
        if (remaining <= 0) throw new ImageGenerationError('IMAGE_TIMEOUT', '生图已达到总耗时上限，停止重试。')
        const deadline = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(requestTimeoutMs, remaining))))
        const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
        attempts++
        emit({ event: 'request', model, attempt: attempts })
        let response, raw
        try {
          response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal })
          raw = await response.text()
        } catch (error) {
          if (signal?.aborted) throw abortError(signal)
          if (deadline.aborted || error.name === 'TimeoutError') throw new ImageGenerationError('IMAGE_TIMEOUT', '生图接口等待超时，未自动重复提交，以免重复生成。请向用户说明后结束本轮。')
          throw new ImageGenerationError('IMAGE_NETWORK', '连接生图服务失败。请向用户说明网络错误；不要自动换模型或执行系统扫描。')
        }
        let payload
        try { payload = JSON.parse(raw) } catch { /* classify status before response format */ }
        if (response.status === 429) {
          const reset = retryAfterSeconds(response.headers, payload, now())
          const seconds = reset ?? 30 * 2 ** (attempts - 1)
          const entry = { until: now() + Math.max(1, seconds) * 1000 + 1000, unknown: reset === undefined }
          cooldowns.set(key, entry)
          if (attempts > maxRetries) throw cooldownError(model, entry.until, now(), entry.unknown)
          await waitFor(entry)
          continue
        }
        if (!response.ok) {
          const message = redactMessage(payload?.error?.message ?? payload?.message ?? response.statusText, secrets)
          throw new ImageGenerationError('IMAGE_HTTP_ERROR', `生图接口返回 HTTP ${response.status}：${message}。请向用户说明，停止自动换模型和系统排查。`, { status: response.status })
        }
        if (!payload || typeof payload !== 'object') throw new ImageGenerationError('IMAGE_INVALID_RESPONSE', '生图服务未返回有效 JSON。请检查配置的接口，不要自动换模型。')
        cooldowns.delete(key)
        const elapsedMs = now() - started
        emit({ event: 'response', model, status: response.status, attempts, elapsed_ms: elapsedMs, waited_ms: waitedMs })
        return { payload, attempts, elapsedMs, waitedMs }
      }
    }
  return {
    async request(options) {
      const started = now()
      try { return await request(options) } catch (error) {
        emit({ event: 'failed', model: options.model, code: error.code ?? 'IMAGE_ERROR', elapsed_ms: now() - started })
        throw error
      }
    },
  }
}
