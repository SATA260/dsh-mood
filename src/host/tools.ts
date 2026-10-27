import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BIPOLAR_FEATURE_IDS, INTENSITIES, PRESENCE_FEATURE_IDS, TRAIT_IDS } from '../shared/types.js'
import type { CallContext, MutationResult } from '../shared/types.js'
import type { MoodStore } from './store.js'

const judgment = {
  direction: { type: 'string', enum: ['positive', 'negative'], required: true },
  intensity: { type: 'string', enum: INTENSITIES, required: true },
  reason: { type: 'string', required: true },
  evidence: { type: 'array', items: { type: 'string' }, required: true, description: '真实依据ID；current_user_message=当前用户消息，last_tool_result=上一项外部工具结果。自己的话、表情和状态工具结果不是新依据，不得编造或拆分。' },
} as const

export function moodTools(store: MoodStore, context: (exec: ToolRunContext) => CallContext) {
  // B returns a JSON DTO; its named interfaces intentionally have no index signature.
  const canonical = (value: unknown) => value as InferValue<{ type: 'json' }>
  const result = (value: MutationResult) => canonical({ ...value, state: { version: value.state.version, traits: value.state.traits, emotions: value.state.emotions } })
  const output = { schema: { type: 'json' } as const, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
  return [
    defineTool({
      name: 'mood_update_emotion', description: '标注真实事件，代码计算并限速；同一事件合并提交一次，不接受数值。冒犯发生用 conflict/present，冲突修复用 conflict/relieved；这是发生/缓解，不是好事/坏事。结果仅内部参考，回复不报分值、额度或更新过程。',
      parameters: {
        event_id: { type: 'string', required: true, description: '优先用 current_user_message 或 last_tool_result；也可用已知真实宿主ID。不要填写消息原文、事件名称或自造ID。' },
        features: { type: 'array', required: true, items: { oneOf: [
          { type: 'object', additionalProperties: false, properties: {
            feature_id: { type: 'string', enum: BIPOLAR_FEATURE_IDS, required: true },
            ...judgment,
            direction: { type: 'string', enum: ['positive', 'negative'], required: true, description: '分别为：目标成功/失败、互动增多/独处机会、新奇/熟悉、亲近/疏远。不按性格预先翻转。' },
          } },
          { type: 'object', additionalProperties: false, properties: {
            feature_id: { type: 'string', enum: PRESENCE_FEATURE_IDS, required: true, description: 'obstruction受阻、conflict冒犯冲突、threat威胁、unexpectedness意外。' },
            ...judgment,
            direction: { type: 'string', enum: ['present', 'relieved'], required: true, description: 'present=该情况发生或加重；relieved=该情况有事实依据地减轻或解除。不是好坏评价；没有新情况不等于缓解。' },
          } },
        ] } },
      }, output, isConcurrencySafe: () => false,
      async execute(args, exec) { exec.signal.throwIfAborted(); return result(store.applyEmotion(args, context(exec))) },
    }),
    defineTool({
      name: 'mood_update_personality', description: '单个真实经历也可微量塑造性格，自主判断属性与方向；一个有效依据即可，无需等重复经历或先查历史。mode=update（默认）提供 attribute_id、direction、intensity、reason、evidence；只接受定性，不接受数值，同一属性不重复使用依据。可选 mode=inspect 只传 attribute_id 查询旧事件摘要。结果仅内部参考，回复不报分值、额度或更新过程。',
      parameters: {
        mode: { type: 'string', enum: ['inspect', 'update'] },
        attribute_id: { type: 'string', enum: TRAIT_IDS, required: true },
        direction: { type: 'string', enum: ['positive', 'negative'] },
        intensity: { type: 'string', enum: INTENSITIES },
        reason: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' }, description: judgment.evidence.description },
      },
      output, isConcurrencySafe: () => false,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const ctx = context(exec)
        const { mode, ...proposal } = args
        if (mode === 'inspect') {
          if (Object.keys(proposal).some(key => key !== 'attribute_id' && proposal[key as keyof typeof proposal] !== undefined)) throw new Error('inspect 仅接受 attribute_id，不提交变化。')
          return canonical({ status: 'inspection', candidates: store.personalityEvidence(args.attribute_id), minimumEvents: store.config.minTraitEvidence })
        }
        return result(store.applyPersonality(proposal, ctx))
      },
    }),
  ]
}
