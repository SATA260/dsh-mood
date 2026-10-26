import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isAbsolute, join } from 'node:path'
import { MoodStore } from './host/store.js'
import { moodTools } from './host/tools.js'
import { PromptManager } from './prompt/manager.js'
import { registerStickerAssets } from './stickers/assets.js'
import { StickerService } from './stickers/service.js'
import { MoodService } from './host/service.js'
import type { CallContext } from './shared/types.js'

export { MoodStore } from './host/store.js'
export { PromptManager } from './prompt/manager.js'
export { MoodService } from './host/service.js'
export { resolveDynamics, DEFAULT_DYNAMICS } from './core/config.js'
export type * from './shared/types.js'
export interface Config { dataDir?: string; dynamics?: Record<string, unknown> }
export const Config: z<Config> = z.object({ dataDir: z.string().description('可选绝对数据目录；默认使用当前 profile/data/dsh-mood'), dynamics: z.dict(z.any()).default({}) })
export const name = 'dsh-mood'
export const inject = ['systemPrompt', 'tools']

export function apply(ctx: Context, config: Config = {}): void {
  const profile = ctx.get('profileContext') as { dir: string } | undefined
  if (config.dataDir && !isAbsolute(config.dataDir)) throw new Error('dataDir 必须是绝对路径')
  if (!config.dataDir && !profile?.dir) throw new Error('dsh-mood 需要 profileContext 或显式 dataDir，不能把聊天工作目录当作数据目录。')
  const store = new MoodStore(join(config.dataDir ?? join(profile!.dir, 'data', 'dsh-mood'), 'mood.sqlite'), { dynamics: config.dynamics })
  ctx.effect(() => () => store.close())
  ctx.plugin(MoodService, { store })
  ctx.plugin(StickerService)
  registerStickerAssets(ctx)
  const prompt = new PromptManager(store)
  const references = new Map<string, CallContext>()
  const calls = new Map<string, string>()
  const selfResults = new Set<string>()
  const text = (blocks: readonly { type: string; text?: string }[]) => blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
  const context = (exec: ToolRunContext): CallContext => {
    if (!exec.agent) throw new Error('状态工具必须由会话中的主模型调用')
    selfResults.add(`${exec.agent.id}:${exec.rootCallId}`)
    return { ...references.get(exec.agent.id), sessionId: exec.agent.id, callId: exec.callId }
  }
  for (const tool of moodTools(store, context)) ctx.tools.register(tool)
  // Observe failures too: schema-rejected subcalls never enter execute(),
  // but their wrapper result must still be excluded as self-generated evidence.
  ctx.on('tools/result', exec => {
    if (exec.agent && (exec.name === 'mood_update_emotion' || exec.name === 'mood_update_personality')) selfResults.add(`${exec.agent.id}:${exec.rootCallId}`)
    return undefined
  })
  ctx.systemPrompt.section({ name: 'dsh-mood:state', order: 400, interpolate: false, text: assembly => prompt.text(assembly.scope) })
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    let refs = references.get(agent.id)
    if (!refs) references.set(agent.id, refs = { sessionId: agent.id, callId: '' })
    for (const message of decision.messages) if (message.source.kind === 'user') {
      const id = `${agent.id}:message:${message.id}`
      store.addEvidence({ id, sessionId: agent.id, kind: 'user', at: Date.now(), text: text(message.content) })
      refs.currentUserId = id
    }
    prompt.begin(agent, agent.id, turn)
    return decision
  }, { prepend: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') calls.set(`${session.id}:${event.data.callId}`, event.data.name)
    if (event.type !== 'tool/result') return
    const message = event.data.message
    const key = `${session.id}:${message.toolCallId}`
    const toolName = calls.get(key)
    calls.delete(key)
    if (selfResults.delete(key) || !toolName || toolName === 'mood_update_emotion' || toolName === 'mood_update_personality') return
    const id = `${session.id}:tool:${message.toolCallId}`
    store.addEvidence({ id, sessionId: session.id, kind: 'tool', at: event.time, text: text(message.content) })
    const refs = references.get(session.id) ?? { sessionId: session.id, callId: '' }
    refs.lastToolId = id
    references.set(session.id, refs)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    references.delete(agent.id)
    for (const key of calls.keys()) if (key.startsWith(`${agent.id}:`)) calls.delete(key)
    for (const key of selfResults) if (key.startsWith(`${agent.id}:`)) selfResults.delete(key)
  })
}
