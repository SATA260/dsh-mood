import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readFile } from 'node:fs/promises'
import { sticker } from './catalog.js'
import type { StickerAsset } from '../shared/types.js'

declare module '@deepseek-ai/cordis' { interface Context { moodStickers: StickerService } }

/** C's read-only resource endpoint works over Desktop IPC without a Web server. */
export class StickerService extends TypertRemoteService {
  private readonly root: URL
  constructor(ctx: Context, config: { assetRoot?: URL } = {}) {
    super(ctx, 'moodStickers')
    this.root = config.assetRoot ?? new URL('./assets/', import.meta.url)
  }
  @Remote
  async getImage(request: { id: string }): Promise<StickerAsset | null> {
    const item = sticker(request.id)
    if (!item) return null
    try {
      const bytes = await readFile(new URL(item.file, this.root))
      return { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
}
