import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FEATURE_IDS, INTENSITIES, TRAIT_IDS } from '../shared/types.js'
import type { CallContext, MutationResult } from '../shared/types.js'
import type { MoodStore } from './store.js'

const judgment = {
  direction: { type: 'string', enum: ['positive', 'negative'], required: true },
  intensity: { type: 'string', enum: INTENSITIES, required: true },
  reason: { type: 'string', required: true },
  evidence: { type: 'array', items: { type: 'string' }, required: true },
} as const

export function moodTools(store: MoodStore, context: (exec: ToolRunContext) => CallContext) {
  // B returns a JSON DTO; its named interfaces intentionally have no index signature.
  const canonical = (value: MutationResult) => value as unknown as InferValue<{ type: 'json' }>
  const output = { schema: { type: 'json' } as const, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
  return [
    defineTool({
      name: 'mood_update_emotion', description: '标注一个真实事件的定性特征；代码按性格计算情绪变化并限速。相同事件只提交一次，不接受数值。',
      parameters: {
        event_id: { type: 'string', required: true, description: '宿主依据ID，或 current_user_message / last_tool_result' },
        features: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { feature_id: { type: 'string', enum: FEATURE_IDS, required: true }, ...judgment } } },
      }, output, isConcurrencySafe: () => false,
      async execute(args, exec) { exec.signal.throwIfAborted(); return canonical(store.applyEmotion(args, context(exec))) },
    }),
    defineTool({
      name: 'mood_update_personality', description: '至少三个不同真实事件支持时提出一次慢速性格变化；只接受方向、程度、理由和依据，不接受数值。',
      parameters: { attribute_id: { type: 'string', enum: TRAIT_IDS, required: true }, ...judgment },
      output, isConcurrencySafe: () => false,
      async execute(args, exec) { exec.signal.throwIfAborted(); return canonical(store.applyPersonality(args, context(exec))) },
    }),
  ]
}
