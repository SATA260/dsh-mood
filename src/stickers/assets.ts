import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { stickers } from './catalog.js'

/** C's allowlisted images on the Host resource server; no independent server. */
export function registerStickerAssets(ctx: Context): void {
  const files = new Set(stickers.map(item => item.file))
  const prefix = '/plugins/dsh-mood/assets'
  ctx.inject(['webServer'], ctx => {
    ctx.webServer.register({ kind: 'prefix', path: prefix, async handler(req, res) {
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return }
      let file: string
      try { file = decodeURIComponent(new URL(req.url ?? '', 'http://dsh.invalid').pathname.slice(prefix.length + 1)) }
      catch { res.writeHead(400); res.end(); return }
      if (!files.has(file)) { res.writeHead(404); res.end(); return }
      try {
        // Build keeps index.js beside assets/, independent of installation path.
        const bytes = await readFile(new URL(`./assets/${file}`, import.meta.url))
        const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`
        const headers = { 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=3600', ETag: etag }
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return }
        res.writeHead(200, { ...headers, 'Content-Length': bytes.length })
        res.end(method === 'HEAD' ? undefined : bytes)
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
        res.writeHead(missing ? 404 : 500); res.end()
        if (!missing) ctx.logger.warn('dsh-mood 表情资源读取失败', error)
      }
    } })
  })
}
