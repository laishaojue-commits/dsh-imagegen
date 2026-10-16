import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const requireRuntime = createRequire(join(dirname(process.execPath), 'resources/app.asar/dsh/package.json'))
await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/cordis-plugin-loader')).href)
const plugin = await import('../index.js')
const originalFetch = globalThis.fetch
const temp = await mkdtemp(join(tmpdir(), 'dsh-imagegen-smoke-'))
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const imagePayload = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] }
let checks = 0
function setup(responses) {
  let fetches = 0, definition, systemPrompt
  globalThis.fetch = async () => { fetches++; const next = responses.shift(); assert.ok(next, 'unexpected HTTP request'); return next }
  const config = plugin.Config({ url: 'https://example.test', apiKey: 'test-only-key', defaultModel: 'gemini-test-image' })
  plugin.apply({ inject() {}, systemPrompt: { section(value) { systemPrompt = value.text } },
    tools: { register(value) { definition = value } } }, config)
  assert.equal(definition.name, 'image_generate')
  assert.ok(systemPrompt.includes('END the turn'))
  return { definition, calls: () => fetches }
}
const exec = { signal: AbortSignal.timeout(30000), agent: { session: { header: { cwd: temp } } } }
try {
  const config = plugin.Config({})
  assert.equal(config.allowModelOverride, false)
  assert.equal(config.maxRetries, 1)
  assert.equal(config.maxCooldownWaitMs, 60000)
  checks++
  const h = setup([new Response(JSON.stringify(imagePayload), { status: 200 })])
  const result = await h.definition.execute({ prompt: 'test fixture', output_path: 'fixture.png' }, exec)
  assert.equal(result.model, 'gemini-test-image')
  assert.equal(result.attempts, 1); assert.equal(result.waited_ms, 0)
  assert.deepEqual(await readFile(result.path), Buffer.from(png, 'base64'))
  assert.ok(Number.isInteger(result.elapsed_ms)); assert.equal(h.calls(), 1)
  checks++
  await assert.rejects(h.definition.execute({ prompt: 'x', model: 'chat-model' }, exec), { code: 'IMAGE_MODEL_LOCKED' })
  assert.equal(h.calls(), 1)
  checks++
  const missing = setup([new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'no image' }] } }] }), { status: 200 })])
  await assert.rejects(missing.definition.execute({ prompt: 'x' }, exec), { code: 'IMAGE_NO_IMAGE' })
  assert.equal(missing.calls(), 1)
  checks++
  const long = setup([new Response(JSON.stringify({ error: { reset_seconds: 572 } }), { status: 429 })])
  for (let i = 0; i < 2; i++) await assert.rejects(long.definition.execute({ prompt: 'x' }, exec), { code: 'IMAGE_COOLDOWN' })
  assert.equal(long.calls(), 1)
  checks++
  const short = setup([new Response(JSON.stringify({ error: { reset_seconds: 0 } }), { status: 429 }),
    new Response(JSON.stringify(imagePayload), { status: 200 })])
  const retry = await short.definition.execute({ prompt: 'x', output_path: 'retry.png' }, exec)
  assert.equal(retry.attempts, 2); assert.equal(short.calls(), 2)
  assert.ok(retry.waited_ms >= 1000)
  checks++
  console.log(JSON.stringify({ desktop_runtime: '0.2.0-rc.2', checks_passed: checks, real_api_calls: 0 }))
} finally {
  globalThis.fetch = originalFetch
  for (const filename of ['fixture.png', 'retry.png']) await unlink(join(temp, filename)).catch((error) => { if (error.code !== 'ENOENT') throw error })
  await rmdir(temp)
}
