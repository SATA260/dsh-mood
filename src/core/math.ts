import { EMOTION_IDS } from '../shared/types.js'
import type { EmotionFeature, Emotions, Features, Traits } from '../shared/types.js'
import type { DynamicsConfig } from './config.js'

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export function baseline(traits: Traits, config: DynamicsConfig): Emotions {
  return { valence: config.baselineOptimism * traits.outcome_expect / 100, affinity: 0, anger: 0, fear: 0, surprise: 0 }
}

export function halfLives(traits: Traits, config: DynamicsConfig): Emotions {
  const factor = 2 ** (-traits.recovery / 100)
  return Object.fromEntries(EMOTION_IDS.map(id => [id, config.halfLivesMs[id] * factor])) as Emotions
}

/** 只计算一个参数不变的时间段；跨越参数变更时由存储层分段调用。 */
export function decay(emotions: Emotions, traits: Traits, elapsedMs: number, config: DynamicsConfig): Emotions {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError('回稳时间差必须为非负有限值')
  const b = baseline(traits, config)
  const tau = halfLives(traits, config)
  return Object.fromEntries(EMOTION_IDS.map(id => [id, b[id] + (emotions[id] - b[id]) * 2 ** (-elapsedMs / tau[id])])) as Emotions
}

export function eventVector(features: readonly EmotionFeature[], config: DynamicsConfig): Features {
  const vector: Features = { outcome: 0, interaction: 0, novelty: 0, closeness: 0, obstruction: 0, conflict: 0, threat: 0, unexpectedness: 0 }
  for (const f of features) vector[f.feature_id] = (f.direction === 'positive' ? 1 : -1) * config.emotionLevels[f.intensity]
  return vector
}

/** 事件价值允许不同性格产生相反感受；增益只调幅度。 */
export function emotionReaction(traits: Traits, features: readonly EmotionFeature[], config: DynamicsConfig): Emotions {
  const vector = eventVector(features, config)
  return Object.fromEntries(EMOTION_IDS.map(id => {
    let q = 0
    for (const [feature, weight] of Object.entries(config.weights[id])) {
      if (!weight) continue
      q += vector[feature as keyof Features] * weight.amount * (weight.trait ? traits[weight.trait] / 100 : 1)
    }
    q = clamp(q, -1, 1)
    const gain = clamp(1 + config.sensitivity[id] * traits.reactivity / 100 + config.optimism[id] * traits.outcome_expect / 100 * Math.sign(q), config.gainMin, config.gainMax)
    return [id, config.emotionScale * gain * q]
  })) as Emotions
}
