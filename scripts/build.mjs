import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
await rm('lib', { recursive: true, force: true })
await mkdir('lib/assets', { recursive: true })
execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json', '--emitDeclarationOnly'], { stdio: 'inherit' })
execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.client.json', '--emitDeclarationOnly'], { stdio: 'inherit' })
await build({ entryPoints: ['src/index.ts', 'src/remote.ts', 'src/typert.host.ts'], outdir: 'lib', bundle: true, platform: 'node', format: 'esm', target: 'node22.19', packages: 'external', tsconfig: 'tsconfig.json' })
await build({ entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'], loader: { '.css': 'text' }, tsconfig: 'tsconfig.client.json', banner: { js: 'window.__ModuleLoader__.load({id:"dsh-mood",factory:(require)=>{var module={exports:{}};var exports=module.exports;' }, footer: { js: 'return module.exports;}});' } })
await cp('stickers', 'lib/assets', { recursive: true })
console.log('Built Host, Client, strict Remote contract, declarations and 32 stickers.')
