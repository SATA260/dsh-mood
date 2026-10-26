import { describe, expect, it } from 'vitest'
import { MoodStore } from '../../src/host/store.js'
import { PromptManager } from '../../src/prompt/manager.js'
import { extractSticker, stickers, stickerUrl } from '../../src/stickers/catalog.js'
import { existsSync } from 'node:fs'

describe('A: frozen per-turn prompt snapshots', () => {
  it('shares values across chats, freezes continuations, reuses durable retry snapshot and retains fractions', () => {
    const store = new MoodStore(':memory:', { now: () => 1000 })
    const manager = new PromptManager(store)
    const scope = {}
    const first = manager.begin(scope, 's1', 1)
    store.setTraits({ social_pref: 80.25 }, 0)
    expect(manager.begin(scope, 's1', 1)).toBe(first)
    expect(manager.text(scope)).toContain('social_pref 社交取向: 0%')
    expect(new PromptManager(store).begin({}, 's1', 1).text).toBe(first.text)
    expect(manager.begin(scope, 's1', 2).text).toContain('80.25%')
    expect(manager.begin({}, 's2', 1).state.traits.social_pref).toBe(80.25)
    expect(manager.text({})).toBe('')
    store.close()
  })
})
describe('C: final response marker projection', () => {
  it('keeps all 32 existing IDs and resolves only packaged paths', () => {
    expect(stickers).toHaveLength(32)
    expect(new Set(stickers.map(s => s.id)).size).toBe(32)
    for (const s of stickers) expect(existsSync(`stickers/${s.file}`)).toBe(true)
    expect(stickerUrl('smile')).toBe('/plugins/dsh-mood/assets/ds-001-smile.jpg')
    expect(stickerUrl('../anything')).toBeUndefined()
  })
  it('emits one valid marker and handles chunking, unknown IDs and history identically', () => {
    const text = '你好。\n\n[dsh-mood-sticker]: smile\n[dsh-mood-sticker]: cry'
    for (let length = 0; length < text.length; length++) expect(extractSticker(text.slice(0, length), false)).toBeUndefined()
    expect(extractSticker(text)?.id).toBe('smile')
    expect(extractSticker(JSON.parse(JSON.stringify(text)))?.id).toBe('smile')
    expect(extractSticker('[dsh-mood-sticker]: invalid')).toBeUndefined()
  })
  it.each(['```text\n[dsh-mood-sticker]: smile\n```', '    [dsh-mood-sticker]: smile', '> [dsh-mood-sticker]: smile', '`[dsh-mood-sticker]: smile`', '示例 [dsh-mood-sticker]: smile'])('does not interpret code or quoted examples: %s', text => expect(extractSticker(text)).toBeUndefined())
})
