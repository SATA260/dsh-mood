/** Deterministic local test adapter. Never shipped in the plugin tarball. */
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
class KeylessAdapter extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'mood-test', name: 'Mood Keyless Test', inputModalities: ['text'] }] }
  async *stream(options) {
    options.signal?.throwIfAborted()
    const user = options.messages.filter(m => m.role === 'user' && m.source?.kind === 'user').at(-1) ?? options.messages.findLast(m => m.role === 'user' && m.content.some(b => b.type === 'text' && /\[no-update\]|目标完成/.test(b.text)))
    const text = user?.content.filter(b => b.type === 'text').map(b => b.text).join('') ?? ''
    const last = options.messages.at(-1)
    if (last?.role !== 'tool' && !text.includes('[no-update]')) {
      const scenarios = {
        'neutral-happy': ['interaction', 'positive', 'slight'],
        'neutral-like': ['closeness', 'positive', 'slight'],
        'neutral-sad': ['outcome', 'negative', 'slight'],
        'neutral-anger': ['conflict', 'present', 'slight'],
        'neutral-fear': ['threat', 'present', 'slight'],
        'neutral-surprise': ['unexpectedness', 'present', 'slight'],
        'neutral-none': ['interaction', 'positive', 'none'],
      }
      const scenario = Object.keys(scenarios).find(name => text.includes(name))
      const [feature_id, direction, intensity] = scenario ? scenarios[scenario] : ['outcome', 'positive', 'moderate']
      const personality = text.includes('micro-personality')
      const args = personality ? { attribute_id: 'explore_pref', direction: 'positive', intensity: 'moderate', reason: '一次主动探索的经历', evidence: ['current_user_message'] } : { event_id: 'current_user_message', features: [{ feature_id, direction, intensity, reason: scenario ? `回归场景 ${scenario}` : '测试中的明确完成事件', evidence: ['current_user_message'] }] }
      const block = { type: 'tool-call', id: ToolCallId(randomUUID()), name: personality ? 'mood_update_personality' : 'mood_update_emotion', arguments: JSON.stringify(args) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    let reply = '收到，我们继续。\n\n[dsh-mood-sticker]: smile'
    if (text.includes('code-example')) reply = '代码示例：\n\n```text\n[dsh-mood-sticker]: smile\n```'
    if (text.includes('unknown-sticker')) reply = '收到。\n\n[dsh-mood-sticker]: nonexistent'
    if (text.includes('multi-sticker')) reply += '\n[dsh-mood-sticker]: cry'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const fragment of reply.match(/.{1,5}|\n/g) ?? []) {
      options.signal?.throwIfAborted()
      yield { type: 'text-delta', index: 0, text: fragment }
      await new Promise(resolve => setTimeout(resolve, 12))
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const inject = ['llm']
export function apply(ctx) { ctx.llm.registerAdapter(['mood-test'], new KeylessAdapter()) }
