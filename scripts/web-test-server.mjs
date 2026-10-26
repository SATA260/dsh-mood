import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const bin = join(dirname(manifestPath), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh)
const home = await mkdtemp(join(tmpdir(), 'dsh-mood-web-'))
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
const port = process.env.DSH_MOOD_TEST_PORT ?? '18782'
let child
async function run(args) {
  return new Promise((resolveRun, reject) => {
    const proc = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    proc.stdout.on('data', d => { output += d })
    proc.stderr.on('data', d => { output += d })
    proc.on('error', reject)
    proc.on('exit', code => code === 0 ? resolveRun(output) : reject(new Error(output)))
  })
}
try {
  await run(['web', '--help'])
  const pluginManifest = JSON.parse(await readFile('package.json', 'utf8'))
  await run(['plugin', '--profile', 'web', 'add', resolve(`dist/dsh-mood-${pluginManifest.version}.tgz`)])
  const patch = join(home, 'keyless.patch.yml')
  await writeFile(patch, `- id: agent-default-model\n  config:\n    provider: mood-test\n    model: mood-test\n- id: tools\n  config:\n    mode: native\n- id: session-title-llm\n  disabled: true\n- insert:\n    - id: mood-test-provider\n      name: ${JSON.stringify(resolve('tests/fixtures/keyless-provider.mjs'))}\n`)
  child = spawn(process.execPath, [bin, 'web', '--patch', patch, '--no-open', '--port', port], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', async data => {
    output += data
    const match = output.match(/dsh web: (http:\/\/[^\s]+)/)
    if (!match) return
    await mkdir('test-results', { recursive: true })
    await writeFile('test-results/host.json', JSON.stringify({ url: match[1], home }), { mode: 0o600 })
    console.log('MOOD_WEB_TEST_READY')
  })
  child.stderr.on('data', data => process.stderr.write(data))
  const stop = () => child?.kill('SIGINT')
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  await new Promise(resolveRun => child.on('exit', resolveRun))
} finally { await rm(home, { recursive: true, force: true }) }
