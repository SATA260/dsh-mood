import { EMOTION_DEFINITIONS, EMOTION_IDS, FEATURE_IDS, INTENSITIES, PRESENCE_FEATURE_IDS, TRAIT_IDS } from '../shared/types.js'
import type { EmotionInput, Emotions, TraitInput, Traits } from '../shared/types.js'

export class InputError extends Error {
  override name = 'InputError'
}
export class VersionConflict extends Error {
  override name = 'VersionConflict'
  constructor() { super('状态已被其他聊天修改，请重新读取后保存。') }
}

export function record(input: unknown, label = '输入'): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError(`${label}必须是对象`)
  return input as Record<string, unknown>
}
function keys(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new InputError('包含未知字段；模型不能直接指定数值或目标值。')
}
export function text(input: unknown, label: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new InputError(`${label}必须是非空文本`)
  return input.trim()
}
function evidence(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) throw new InputError('必须引用有效事件依据（最多 64 条）')
  const result = input.map(item => text(item, '依据 ID'))
  if (new Set(result).size !== result.length) throw new InputError('依据 ID 不能重复')
  return result
}
function direction(input: unknown): 'positive' | 'negative' {
  if (input !== 'positive' && input !== 'negative') throw new InputError('方向仅允许 positive 或 negative')
  return input
}
function intensity(input: unknown): typeof INTENSITIES[number] {
  if (!(INTENSITIES as readonly unknown[]).includes(input)) throw new InputError('程度仅允许 none、slight、moderate、intense')
  return input as typeof INTENSITIES[number]
}

export function parseEmotion(input: unknown): EmotionInput {
  const root = record(input)
  keys(root, ['event_id', 'features'])
  if (!Array.isArray(root.features) || !root.features.length || root.features.length > FEATURE_IDS.length) throw new InputError('features 需要 1～8 项事件特征')
  const features = root.features.map(item => {
    const f = record(item, '事件特征')
    keys(f, ['feature_id', 'direction', 'intensity', 'reason', 'evidence'])
    if (!(FEATURE_IDS as readonly unknown[]).includes(f.feature_id)) throw new InputError('未知事件特征')
    const feature_id = f.feature_id as typeof FEATURE_IDS[number]
    const condition = (PRESENCE_FEATURE_IDS as readonly string[]).includes(feature_id)
    const eventDirection = condition ? presenceDirection(f.direction, feature_id) : direction(f.direction)
    return { feature_id, direction: eventDirection, intensity: intensity(f.intensity), reason: text(f.reason, '原因'), evidence: evidence(f.evidence) }
  })
  if (new Set(features.map(f => f.feature_id)).size !== features.length) throw new InputError('同一事件不能重复提交同一特征')
  return { event_id: text(root.event_id, '事件 ID'), features }
}

function presenceDirection(input: unknown, feature: string): 'present' | 'relieved' {
  if (input !== 'present' && input !== 'relieved') throw new InputError(`${feature} 必须用 present（发生／加重）或 relieved（缓解／解除）；不能用 positive/negative 表示好坏。请按事实重新标注。`)
  return input
}

export function parseTrait(input: unknown): TraitInput {
  const root = record(input)
  keys(root, ['attribute_id', 'direction', 'intensity', 'reason', 'evidence'])
  if (!(TRAIT_IDS as readonly unknown[]).includes(root.attribute_id)) throw new InputError('未知性格属性')
  return { attribute_id: root.attribute_id as typeof TRAIT_IDS[number], direction: direction(root.direction), intensity: intensity(root.intensity), reason: text(root.reason, '原因'), evidence: evidence(root.evidence) }
}

export function parseTraitPatch(input: unknown): Partial<Traits> {
  const patch = record(input, '性格修改')
  keys(patch, [...TRAIT_IDS])
  if (!Object.keys(patch).length) throw new InputError('没有需要保存的修改')
  for (const value of Object.values(patch)) if (typeof value !== 'number' || !Number.isFinite(value) || value < -100 || value > 100) throw new InputError('性格数值必须在 -100～100 内')
  return patch as Partial<Traits>
}

export function parseEmotionPatch(input: unknown): Partial<Emotions> {
  const patch = record(input, '情绪修改')
  keys(patch, [...EMOTION_IDS])
  if (!Object.keys(patch).length) throw new InputError('没有需要保存的修改')
  for (const d of EMOTION_DEFINITIONS) {
    const value = patch[d.id]
    if (Object.hasOwn(patch, d.id) && (typeof value !== 'number' || !Number.isFinite(value) || value < d.min || value > d.max)) throw new InputError(`${d.name}必须在 ${d.min}～${d.max} 内`)
  }
  return patch as Partial<Emotions>
}
