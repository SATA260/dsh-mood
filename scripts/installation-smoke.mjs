import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
const require = createRequire(import.meta.url)
const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const bin = join(dirname(manifestPath), manifest.bin.dsh)
const home = await mkdtemp(join(tmpdir(), 'mood-install-'))
const resultPath = join(home, 'probe.json')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_MOOD_SMOKE_RESULT: resultPath }
const tarball = resolve('dist/dsh-mood-0.1.0.tgz')
let child
async function command(args) {
  let output = ''
  const proc = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout.on('data', d => { output += d }); proc.stderr.on('data', d => { output += d })
  await new Promise((done, reject) => { proc.on('error', reject); proc.on('exit', code => code === 0 ? done() : reject(new Error(output))) })
}
async function start() {
  await rm(resultPath, { force: true })
  child = spawn(process.execPath, [bin, 'web', '--patch', join(home, 'probe.patch.yml'), '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((done, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Host startup timeout')), 30000)
    const read = data => {
      output += data
      const url = output.match(/dsh web: (http:\/\/[^\s]+)/)?.[1]
      if (url) { clearTimeout(timer); done(url) }
    }
    child.stdout.on('data', read); child.stderr.on('data', read)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Host exit ${code}: ${output}`)) })
  })
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const proc = child
  const exited = new Promise(done => proc.once('exit', done))
  proc.kill('SIGINT'); await exited; child = undefined
}
try {
  await command(['web', '--help'])
  await command(['plugin', '--profile', 'web', 'add', tarball])
  await writeFile(join(home, 'probe.patch.yml'), `- insert:\n    - id: state-probe\n      name: ${JSON.stringify(resolve('tests/fixtures/state-probe.mjs'))}\n`)
  const firstUrl = await start()
  const first = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.equal(first.traits.social_pref, 35.25)
  assert.equal(first.traits.recovery, 80.5)
  const asset = await fetch(new URL('/plugins/dsh-mood/assets/ds-001-smile.jpg', firstUrl))
  assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), 'image/jpeg')
  assert.ok((await asset.arrayBuffer()).byteLength > 1000)
  const head = await fetch(new URL('/plugins/dsh-mood/assets/ds-001-smile.jpg', firstUrl), { method: 'HEAD' })
  assert.equal(head.status, 200); assert.ok(head.headers.get('etag'))
  const cached = await fetch(new URL('/plugins/dsh-mood/assets/ds-001-smile.jpg', firstUrl), { headers: { 'If-None-Match': head.headers.get('etag') } })
  assert.equal(cached.status, 304)
  const traversal = await fetch(new URL('/plugins/dsh-mood/assets/not-in-catalog.jpg', firstUrl))
  assert.equal(traversal.status, 404)
  await stop()
  await start()
  const second = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.deepEqual(second.traits, first.traits); assert.equal(second.version, first.version)
  await stop()
  await command(['plugin', '--profile', 'web', 'remove', 'dsh-mood'])
  const databasePath = join(home, 'profiles/web/data/dsh-mood/mood.sqlite')
  await access(databasePath)
  const db = new DatabaseSync(databasePath, { readOnly: true })
  const preserved = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='state'").get().value)
  db.close(); assert.deepEqual(preserved.traits, first.traits)
  const profile = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'))
  assert.equal(profile.dependencies?.['dsh-mood'], undefined)
  assert.ok(!profile.dsh.profile.bundles.includes('dsh-mood'))
  await mkdir('docs/验收', { recursive: true })
  await writeFile('docs/验收/install.json', JSON.stringify({ dsh: manifest.version, installed: true, webAsset: true, unknownAssetRejected: true, restartPreservedTraitsAndVersion: true, removedFromProfile: true, uninstallPreservedData: true, dataPath: '<profile>/data/dsh-mood/mood.sqlite', persistedTraits: first.traits }, null, 2) + '\n')
  console.log('PASS: official bundle install, Web resources, restart persistence, uninstall and preserved user data.')
} finally { await stop(); await rm(home, { recursive: true, force: true }) }
