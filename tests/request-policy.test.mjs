import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequestPolicy, retryAfterSeconds, selectModel, redactMessage, noImageError } from '../request-policy.js'

const response = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers })
function harness(responses, extras = {}) {
  let clock = Date.parse('2026-10-16T00:00:00Z')
  const calls = [], waits = [], events = []
  const policy = createRequestPolicy({
    now: () => clock,
    fetchImpl: async (...args) => { calls.push(args); return responses.shift() },
    sleep: async (ms) => { waits.push(ms); clock += ms },
    onEvent: (event) => events.push(event), ...extras,
  })
  const options = { endpoint: 'https://example.test/v1beta/models/image:generateContent', model: 'image',
    headers: { Authorization: 'Bearer test-secret', 'content-type': 'application/json' }, body: { prompt: 'apple' } }
  return { policy, options, calls, waits, events }
}

test('default model is fixed and a chat-model override is rejected', () => {
  assert.equal(selectModel(undefined, 'configured-image'), 'configured-image')
  assert.equal(selectModel('configured-image', 'configured-image'), 'configured-image')
  assert.throws(() => selectModel('chat-model', 'configured-image'), { code: 'IMAGE_MODEL_LOCKED' })
  assert.equal(selectModel('custom-image', 'configured-image', true), 'custom-image')
})
test('current reset_seconds wins over stale nested upstream text', () => {
  assert.equal(retryAfterSeconds(new Headers(), { error: { reset_seconds: 47,
    last_upstream_error: JSON.stringify({ error: { message: 'quota reset after 9m32s', retryDelay: '572s' } }) } }), 47)
})
test('Retry-After accepts delta seconds and HTTP dates', () => {
  const now = Date.parse('2026-10-16T00:00:00Z')
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': '12' }), {}, now), 12)
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': 'Fri, 16 Oct 2026 00:00:15 GMT' }), {}, now), 15)
})
test('Google retryDelay and plain quota message fallback are supported', () => {
  assert.equal(retryAfterSeconds(new Headers(), { error: { details: [{ retryDelay: '2.5s' }] } }), 3)
  assert.equal(retryAfterSeconds(new Headers(), { error: { message: 'quota will reset after 1m12s.' } }), 72)
  assert.equal(retryAfterSeconds(new Headers(), { error: { message: 'last error: reset after 9m32s' } }), undefined)
})
test('first-attempt success sends exactly one request', async () => {
  const h = harness([response(200, { candidates: [] })])
  const result = await h.policy.request(h.options)
  assert.equal(result.attempts, 1); assert.equal(result.waitedMs, 0)
  assert.equal(h.calls.length, 1); assert.equal(h.waits.length, 0)
})
test('short cooldown waits to reset plus margin then retries only once', async () => {
  const h = harness([response(429, { error: { reset_seconds: 5 } }), response(200, { data: [] })])
  const result = await h.policy.request(h.options)
  assert.deepEqual(h.waits, [6000]); assert.equal(h.calls.length, 2)
  assert.equal(result.attempts, 2); assert.equal(result.waitedMs, 6000)
})
test('long cooldown returns immediately and repeated calls reuse cached cooldown', async () => {
  const h = harness([response(429, { error: { reset_seconds: 572 } })])
  for (let i = 0; i < 2; i++) await assert.rejects(h.policy.request(h.options), (e) => e.code === 'IMAGE_COOLDOWN' && e.retryAfterSeconds === 573)
  assert.equal(h.calls.length, 1); assert.deepEqual(h.waits, [])
})
test('a second 429 ends retrying', async () => {
  const h = harness([response(429, { error: { reset_seconds: 1 } }), response(429, { error: { reset_seconds: 1 } })])
  await assert.rejects(h.policy.request(h.options), { code: 'IMAGE_COOLDOWN' })
  assert.equal(h.calls.length, 2); assert.equal(h.waits.length, 1)
})
test('missing reset uses bounded 30-second backoff, not a hot polling loop', async () => {
  const h = harness([response(429, {}), response(200, { data: [] })])
  await h.policy.request(h.options)
  assert.deepEqual(h.waits, [31000]); assert.equal(h.calls.length, 2)
})
test('insufficient total budget reports cooldown without sleeping', async () => {
  const h = harness([response(429, { error: { reset_seconds: 30 } })])
  await assert.rejects(h.policy.request({ ...h.options, timeoutMs: 50000, requestTimeoutMs: 40000 }), { code: 'IMAGE_COOLDOWN' })
  assert.deepEqual(h.waits, []); assert.equal(h.calls.length, 1)
})
test('zero retry limit makes exactly one request', async () => {
  const h = harness([response(429, { error: { reset_seconds: 1 } })])
  await assert.rejects(h.policy.request({ ...h.options, maxRetries: 0 }), { code: 'IMAGE_COOLDOWN' })
  assert.equal(h.calls.length, 1); assert.deepEqual(h.waits, [])
})
test('HTTP configuration errors are not retried and redact credentials', async () => {
  const h = harness([response(400, { error: { message: 'bad test-secret Bearer abc-123' } })])
  await assert.rejects(h.policy.request(h.options), (e) => e.code === 'IMAGE_HTTP_ERROR' && !e.message.includes('test-secret') && !e.message.includes('abc-123'))
  assert.equal(h.calls.length, 1)
})
test('network errors and timeouts have distinct codes and no duplicate submissions', async () => {
  for (const [name, code] of [['TypeError', 'IMAGE_NETWORK'], ['TimeoutError', 'IMAGE_TIMEOUT']]) {
    let calls = 0
    const h = harness([], { fetchImpl: async () => { calls++; const e = new Error('failure'); e.name = name; throw e } })
    await assert.rejects(h.policy.request(h.options), { code }); assert.equal(calls, 1)
  }
})
test('timeout covers response body consumption, not just receiving headers', async () => {
  const h = harness([], { fetchImpl: async (_url, options) => ({ text: () => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('test timeout')), 1000)
    options.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(options.signal.reason) }, { once: true })
  }) }) })
  await assert.rejects(h.policy.request({ ...h.options, requestTimeoutMs: 10 }), { code: 'IMAGE_TIMEOUT' })
})
test('user cancellation does not submit another request', async () => {
  const h = harness([])
  await assert.rejects(h.policy.request({ ...h.options, signal: AbortSignal.abort() }), { code: 'IMAGE_CANCELLED' })
  assert.equal(h.calls.length, 0)
})
test('cancel during cooldown stops without retrying', async () => {
  const controller = new AbortController()
  const h = harness([response(429, { error: { reset_seconds: 2 } })], {
    sleep: async () => { controller.abort(); throw controller.signal.reason },
  })
  await assert.rejects(h.policy.request({ ...h.options, signal: controller.signal }), { code: 'IMAGE_CANCELLED' })
  assert.equal(h.calls.length, 1)
})
test('bad JSON is distinct from a valid response without images', async () => {
  const h = harness([new Response('<html>proxy error</html>', { status: 200 })])
  await assert.rejects(h.policy.request(h.options), { code: 'IMAGE_INVALID_RESPONSE' })
  assert.equal(noImageError('Gemini').code, 'IMAGE_NO_IMAGE')
})
test('logs contain only status metadata, never credentials, endpoint or prompt', async () => {
  const h = harness([response(200, { data: [] })]); await h.policy.request(h.options)
  const text = JSON.stringify(h.events)
  for (const value of ['test-secret', 'example.test', 'apple']) assert.ok(!text.includes(value))
  assert.ok(text.includes('elapsed_ms'))
  assert.equal(redactMessage('secret data:image/png;base64,AAAA', ['secret']), '[REDACTED] [IMAGE DATA]')
})
