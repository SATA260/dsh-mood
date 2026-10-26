import data from '../../stickers/catalog.json' with { type: 'json' }
import { fromMarkdown } from 'mdast-util-from-markdown'

export interface Sticker { id: string; name_zh: string; tags: string[]; file: string }
export const stickers: readonly Sticker[] = data.items
const byId = new Map(stickers.map(item => [item.id, item]))
export function sticker(id: string): Sticker | undefined { return byId.get(id) }
export function stickerUrl(id: string): string | undefined {
  const item = sticker(id)
  return item ? `/plugins/dsh-mood/assets/${item.file.split('/').map(encodeURIComponent).join('/')}` : undefined
}

/** 只处理已结算回复的根级引用定义；围栏、缩进代码和引用块均不触发。 */
export function extractSticker(text: string, settled = true): Sticker | undefined {
  if (!settled) return
  const tree = fromMarkdown(text)
  for (const node of tree.children) {
    if (node.type !== 'definition' || node.identifier !== 'dsh-mood-sticker') continue
    const item = sticker(node.url)
    if (item) return item
  }
}
