import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('client initializes with the DSH 0.2 plugin slot and no removed modules', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let plugin, slot
  const context = { window: { __ModuleLoader__: { load(module) { plugin = module.factory(() => ({})) } } },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, value: { writable: true,
      descriptor: { value: { protocol: 'gemini' }, base: {}, user: {}, revision: 0 } } }) }),
  }
  vm.runInNewContext(source, context)
  plugin.apply({ effect: (effect) => effect(), locale: { register() {} }, slots: {
    inject: (_name, effect) => effect(), register: (descriptor) => { slot = descriptor },
  } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(slot.name, 'plugins.item')
  assert.equal(slot.id, 'imagegen')
  assert.ok(!source.includes("require('@deepseek-ai/dsh-client-runtime"))
})
