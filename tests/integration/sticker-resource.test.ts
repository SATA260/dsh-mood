import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StickerService } from '../../src/stickers/service.js'

const contexts: Context[] = []
const folders: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('serves a catalog image over the Desktop-compatible Remote value without creating affect state', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(StickerService, { assetRoot: pathToFileURL(resolve('stickers') + '/') })
  const asset = await ctx.moodStickers.getImage({ id: 'smile' })
  expect(asset?.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
  const bytes = Buffer.from(asset!.dataUrl.split(',')[1]!, 'base64')
  expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  expect(ctx.get('mood')).toBeUndefined()
  expect(await ctx.moodStickers.getImage({ id: '../package.json' })).toBeNull()
})
it('missing packaged images return no image and preserve the text-only fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mood-images-')); folders.push(dir)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(StickerService, { assetRoot: pathToFileURL(dir + '/') })
  expect(await ctx.moodStickers.getImage({ id: 'smile' })).toBeNull()
})
