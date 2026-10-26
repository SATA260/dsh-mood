import { execFileSync } from 'node:child_process'
import { mkdir, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const file of ['lib/index.js', 'lib/client.js', 'lib/remote.js', 'lib/typert.host.js']) await access(file)
await mkdir('dist', { recursive: true })
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--cache', join(tmpdir(), 'dsh-mood-npm-cache'), '--pack-destination', 'dist', '--json'], { encoding: 'utf8' }))
const files = new Set(pack.files.map(f => f.path))
for (const file of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/client/index.d.ts', 'lib/remote.js', 'lib/remote.d.ts', 'lib/typert.host.js', 'cordis.patch.yml']) if (!files.has(file)) throw new Error(`Missing package entry: ${file}`)
const catalog = JSON.parse(await readFile('stickers/catalog.json', 'utf8'))
for (const item of catalog.items) if (!files.has(`lib/assets/${item.file}`)) throw new Error(`Missing sticker: ${item.id}`)
if (catalog.items.length !== 32 || pack.files.filter(f => f.path.endsWith('.jpg')).length !== 32) throw new Error('Expected exactly 32 stickers')
for (const file of pack.files) {
  if (/^(src|tests|node_modules|experiments|image)\//.test(file.path)) throw new Error(`Unexpected source/test content: ${file.path}`)
  if (/\.(js|d\.ts)$/.test(file.path)) {
    const content = await readFile(file.path, 'utf8')
    if (content.includes('/Users/') || content.includes('/node_modules/.pnpm/')) throw new Error(`Machine-local path in ${file.path}`)
  }
}
await mkdir('docs/验收', { recursive: true })
await import('node:fs/promises').then(fs => fs.writeFile('docs/验收/package.json', JSON.stringify({ filename: pack.filename, size: pack.size, unpackedSize: pack.unpackedSize, shasum: pack.shasum, integrity: pack.integrity, stickers: 32, files: pack.files.length }, null, 2) + '\n'))
console.log(`Verified dist/${pack.filename}: ${pack.files.length} files, 32 stickers, ${Math.round(pack.size / 1024)} KiB.`)
