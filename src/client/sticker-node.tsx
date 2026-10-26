import { useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition, ConversationMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { extractSticker, stickerUrl } from '../stickers/catalog.js'

interface StickerData { id: string; name: string; seq: number }
declare module '@deepseek-ai/dsh-client-ui-chat/client' { interface ChatNodeDataMap { 'dsh-mood-sticker': StickerData } }
function materialize(match: ConversationMatch): StickerData | null {
  if (match.event.type !== 'assistant/message') return null
  const message = match.event.data.message
  if (message.content.some(block => block.type === 'tool-call')) return null
  const found = extractSticker(message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'))
  return found ? { id: found.id, name: found.name_zh, seq: match.event.seq } : null
}
export const stickerDefinition: ConversationNodeDefinition<StickerData | null> = {
  kind: 'dsh-mood-sticker', target: 'chat',
  match(event) {
    if (event.type !== 'assistant/message') return null
    return { id: event.data.message.id, role: 'start' }
  },
  start: (_ctx, match) => materialize(match),
  update: (_ctx, match) => materialize(match),
  buildViewNode(context): ChatConversationViewNode | null {
    const value = context.state
    if (!value || !context.start) return null
    return { key: context.key, kind: 'dsh-mood-sticker', id: context.id, target: 'chat', data: value, anchorSeq: value.seq + .001, location: context.start.location, visibility: 'visible', groupTree: 'turn' }
  },
}
export function StickerImage({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = useState(false)
  const url = stickerUrl(id)
  return url && !failed ? <img className="mood-sticker" src={url} alt={`DeepSeek：${name}`} loading="lazy" onError={() => setFailed(true)} /> : null
}
export function registerStickers(ctx: Context): void {
  ctx.effect(() => ctx.uiConversation.events.register(stickerDefinition))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'dsh-mood-sticker', locale: 'chat' }, ({ node }: ChatNodeViewProps<'dsh-mood-sticker'>) => <StickerImage key={node.data.id} id={node.data.id} name={node.data.name} />))
}
