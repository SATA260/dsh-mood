import { EMOTION_IDS, FEATURE_IDS, INTENSITIES, TRAIT_IDS } from '../shared/types.js'
import type { EmotionId, Emotions, FeatureId, Intensity, TraitId, Traits } from '../shared/types.js'

export interface FeatureWeight { amount: number; trait?: TraitId; offset?: number }
export interface DynamicsConfig {
  reactionVersion: 1 | 2
  initialTraits: Traits
  emotionLevels: Record<Intensity, number>
  traitLevels: Record<Intensity, number>
  emotionScale: number
  sensitivity: Emotions
  optimism: Emotions
  halfLivesMs: Emotions
  baselineOptimism: number
  gainMin: number
  gainMax: number
  emotionPerEvent: number
  emotionPerHour: number
  emotionWindowMs: number
  traitPerEvent: number
  traitPerDay: number
  traitWindowMs: number
  minTraitEvidence: number
  weights: Record<EmotionId, Partial<Record<FeatureId, FeatureWeight>>>
}

export const DEFAULT_DYNAMICS: DynamicsConfig = {
  reactionVersion: 2,
  initialTraits: { social_pref: 0, explore_pref: 0, stance_firm: 0, intimacy_pref: 0, outcome_expect: 0, reactivity: 0, recovery: 0 },
  emotionLevels: { none: 0, slight: 0.2, moderate: 0.5, intense: 1 },
  traitLevels: { none: 0, slight: 0.01, moderate: 0.025, intense: 0.05 },
  emotionScale: 10,
  sensitivity: { valence: 0.3, affinity: 0.4, anger: 0.5, fear: 0.5, surprise: 0.25 },
  optimism: { valence: 0.2, affinity: 0, anger: 0, fear: 0, surprise: 0 },
  halfLivesMs: { valence: 14_400_000, affinity: 21_600_000, anger: 7_200_000, fear: 7_200_000, surprise: 300_000 },
  baselineOptimism: 20,
  gainMin: 0.5,
  gainMax: 1.5,
  emotionPerEvent: 15,
  emotionPerHour: 40,
  emotionWindowMs: 3_600_000,
  traitPerEvent: 0.05,
  traitPerDay: 3,
  traitWindowMs: 86_400_000,
  minTraitEvidence: 1,
  weights: {
    valence: { outcome: { amount: 1 }, interaction: { amount: 1, trait: 'social_pref', offset: 0.4 }, novelty: { amount: 1, trait: 'explore_pref', offset: 0.2 }, closeness: { amount: 1, trait: 'intimacy_pref', offset: 0.5 } },
    affinity: { outcome: { amount: 0.3 }, interaction: { amount: 0.5, trait: 'social_pref', offset: 0.6 }, novelty: { amount: 0.5, trait: 'explore_pref', offset: 0.2 }, closeness: { amount: 1, trait: 'intimacy_pref', offset: 0.5 } },
    anger: { conflict: { amount: 1 }, obstruction: { amount: 0.5 } },
    fear: { threat: { amount: 1 } },
    surprise: { unexpectedness: { amount: 1 } },
  },
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

/** 配置只接受已声明字段；与默认值深合并后再验证所有数值。 */
export function resolveDynamics(input: unknown = {}): DynamicsConfig { return readDynamics(input, false) }

/** Persisted configs are complete snapshots. Never merge newer weight defaults into history. */
export function restoreDynamics(input: unknown): DynamicsConfig { return readDynamics(input, true) }

function readDynamics(input: unknown, stored: boolean): DynamicsConfig {
  const result: DynamicsConfig = structuredClone(DEFAULT_DYNAMICS)
  if (stored) {
    result.reactionVersion = 1 // Pre-0.1.4 configurations predate the version field.
    result.weights = Object.fromEntries(EMOTION_IDS.map(id => [id, {}])) as DynamicsConfig['weights']
  }
  const root = object(input, 'dynamics')
  for (const [key, value] of Object.entries(root)) {
    if (!Object.hasOwn(result, key)) throw new TypeError(`未知的 dynamics 配置：${key}`)
    if (key === 'weights') {
      const weights = object(value, 'weights')
      for (const [axis, fields] of Object.entries(weights)) {
        if (!(EMOTION_IDS as readonly string[]).includes(axis)) throw new TypeError(`未知情绪：${axis}`)
        const row = object(fields, `weights.${axis}`)
        for (const [feature, rule] of Object.entries(row)) {
          if (!(FEATURE_IDS as readonly string[]).includes(feature)) throw new TypeError(`未知事件特征：${feature}`)
          const w = object(rule, feature)
          if (Object.keys(w).some(k => !['amount', 'trait', 'offset'].includes(k))) throw new TypeError('权重包含未知字段')
          if (typeof w.amount !== 'number' || !Number.isFinite(w.amount)) throw new TypeError('权重必须是有限数字')
          if (w.trait !== undefined && !(TRAIT_IDS as readonly unknown[]).includes(w.trait)) throw new TypeError('权重引用了未知性格')
          if (w.offset !== undefined && (w.trait === undefined || typeof w.offset !== 'number' || !Number.isFinite(w.offset) || Math.abs(w.offset) > 1)) throw new TypeError('offset 必须与性格权重一起使用，且为 -1～1 的有限数')
          result.weights[axis as EmotionId][feature as FeatureId] = { amount: w.amount, ...(w.trait === undefined ? {} : { trait: w.trait as TraitId }), ...(w.offset === undefined ? {} : { offset: w.offset as number }) }
        }
      }
    } else if (typeof result[key as keyof DynamicsConfig] === 'object') {
      const target = result[key as keyof DynamicsConfig] as unknown as Record<string, unknown>
      for (const [field, v] of Object.entries(object(value, key))) {
        if (!Object.hasOwn(target, field)) throw new TypeError(`未知配置字段：${key}.${field}`)
        target[field] = v
      }
    } else {
      (result as unknown as Record<string, unknown>)[key] = value
    }
  }
  const finite = (v: unknown, key: string, min: number, max = Number.MAX_VALUE): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new TypeError(`${key} 超出允许范围`)
  }
  if (result.reactionVersion !== 1 && result.reactionVersion !== 2) throw new TypeError('reactionVersion 只允许 1 或 2')
  for (const id of TRAIT_IDS) finite(result.initialTraits[id], id, -100, 100)
  for (const id of EMOTION_IDS) {
    finite(result.sensitivity[id], `sensitivity.${id}`, 0)
    finite(result.optimism[id], `optimism.${id}`, 0)
    finite(result.halfLivesMs[id], `halfLivesMs.${id}`, 1)
  }
  for (const level of INTENSITIES) {
    finite(result.emotionLevels[level], `emotionLevels.${level}`, 0, 1)
    finite(result.traitLevels[level], `traitLevels.${level}`, 0)
  }
  if (result.emotionLevels.none !== 0 || result.traitLevels.none !== 0) throw new TypeError('none 档位必须为 0')
  for (const key of ['emotionScale', 'gainMin', 'gainMax'] as const) finite(result[key], key, Number.EPSILON)
  for (const key of ['emotionPerEvent', 'emotionPerHour', 'traitPerEvent', 'traitPerDay'] as const) finite(result[key], key, 0)
  for (const key of ['emotionWindowMs', 'traitWindowMs'] as const) if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new TypeError(`${key} 必须为正的安全整数毫秒`)
  finite(result.baselineOptimism, 'baselineOptimism', 0, 100)
  finite(result.minTraitEvidence, 'minTraitEvidence', 1, 64)
  if (!Number.isInteger(result.minTraitEvidence)) throw new TypeError('minTraitEvidence 必须是整数')
  if (result.gainMin > result.gainMax) throw new TypeError('gainMin 不能大于 gainMax')
  for (const id of EMOTION_IDS) {
    const maxWeight = Object.values(result.weights[id]).reduce((sum, rule) => sum + Math.abs(rule?.amount ?? 0) * (1 + Math.abs(rule?.offset ?? 0)), 0)
    for (const value of [maxWeight, result.halfLivesMs[id] * 2, result.sensitivity[id] * 100, result.optimism[id] * 100]) {
      if (!Number.isFinite(value)) throw new TypeError(`${id} 配置会导致数值溢出`)
    }
  }
  if (!Number.isFinite(result.emotionScale * result.gainMax)) throw new TypeError('情绪倍率配置会导致数值溢出')
  return result
}
