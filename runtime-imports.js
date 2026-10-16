import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// A linked Desktop plugin must share the application's bundled Cordis/schema
// instances, rather than downloading a second copy beside the linked checkout.
const candidates = [
  import.meta.url,
  ...(process.env.DSH_RUNTIME_DIR ? [join(process.env.DSH_RUNTIME_DIR, 'package.json')] : []),
  ...(process.resourcesPath ? [join(process.resourcesPath, 'app.asar/dsh/package.json')] : []),
  join(dirname(process.execPath), 'resources/app.asar/dsh/package.json'),
  join(dirname(process.execPath), '../Resources/app.asar/dsh/package.json'),
]
let runtimeRequire
for (const candidate of candidates) {
  try {
    const require = createRequire(candidate)
    require.resolve('@deepseek-ai/dsh-tools')
    require.resolve('@deepseek-ai/schemastery')
    runtimeRequire = require
    break
  } catch { /* try the next installed runtime */ }
}
if (!runtimeRequire) throw new Error('dsh-imagegen requires DSH 0.2 peers. Run inside DeepSeek Harness, install the declared peer dependencies for a Web profile, or set DSH_RUNTIME_DIR to its runtime directory.')
const schema = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/schemastery')).href)
const tools = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-tools')).href)
export const z = schema.default
export const defineTool = tools.defineTool
