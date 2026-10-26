import { describe, expect, it } from 'vitest'
import { DEFAULT_DYNAMICS, resolveDynamics } from '../../src/core/config.js'
import { baseline, decay, emotionReaction, halfLives } from '../../src/core/math.js'
import { PRESENCE_FEATURE_IDS } from '../../src/shared/types.js'
import type { EmotionFeature, Emotions, FeatureId, Traits } from '../../src/shared/types.js'

const traits = (patch: Partial<Traits> = {}): Traits => ({ ...DEFAULT_DYNAMICS.initialTraits, ...patch })
const feature = (id: FeatureId, direction?: EmotionFeature['direction'], intensity: EmotionFeature['intensity'] = 'moderate'): EmotionFeature[] => [{ feature_id: id, direction: direction ?? ((PRESENCE_FEATURE_IDS as readonly string[]).includes(id) ? 'present' : 'positive'), intensity, reason: '真实事件', evidence: ['e1'] }]
const zero: Emotions = { valence: 0, affinity: 0, anger: 0, fear: 0, surprise: 0 }

describe('性格如何影响情绪', () => {
  it('同一互动对相反社交倾向产生相反感受', () => {
    const config = resolveDynamics()
    const a = emotionReaction(traits({ social_pref: 80 }), feature('interaction'), config)
    const b = emotionReaction(traits({ social_pref: -80 }), feature('interaction'), config)
    expect(a.valence).toBeCloseTo(6)
    expect(b.valence).toBeCloseTo(-2)
    expect(a.affinity).toBeCloseTo(3.5)
    expect(b.affinity).toBeCloseTo(-0.5)
  })
  it.each([
    ['outcome', 'valence'], ['interaction', 'valence'], ['novelty', 'valence'], ['closeness', 'affinity'],
    ['conflict', 'anger'], ['obstruction', 'anger'], ['threat', 'fear'], ['unexpectedness', 'surprise'],
  ] as const)('中性性格下 %s 也能产生 %s 的基础反应', (id, axis) => {
    for (const reactivity of [-100, 0, 100]) expect(emotionReaction(traits({ reactivity }), feature(id), resolveDynamics())[axis]).toBeGreaterThan(0)
    expect(emotionReaction(traits(), feature(id, undefined, 'none'), resolveDynamics())).toEqual(zero)
  })
  it('乐观改变基线和方向增益，但不暗中改变半衰期', () => {
    const config = resolveDynamics()
    const positive = traits({ outcome_expect: 80 })
    const negative = traits({ outcome_expect: -80 })
    expect(baseline(positive, config).valence).toBe(16)
    expect(baseline(negative, config).valence).toBe(-16)
    expect(emotionReaction(positive, feature('outcome', 'negative'), config).valence).toBeCloseTo(-4.2)
    expect(emotionReaction(negative, feature('outcome', 'negative'), config).valence).toBeCloseTo(-5.8)
    expect(halfLives(positive, config)).toEqual(halfLives(negative, config))
  })
  it('敏感但恢复快，与钝感但恢复慢可以独立组合', () => {
    const config = resolveDynamics()
    const fast = traits({ reactivity: 80, recovery: 100 })
    const slow = traits({ reactivity: -80, recovery: -100 })
    const a = emotionReaction(fast, feature('conflict'), config)
    const b = emotionReaction(slow, feature('conflict'), config)
    expect(a.anger).toBe(7)
    expect(b.anger).toBe(3)
    expect(decay(a, fast, 14_400_000, config).anger).toBeCloseTo(0.4375)
    expect(decay(b, slow, 14_400_000, config).anger).toBeCloseTo(1.5)
  })
  it('恢复能力也加快正面情绪回稳', () => {
    const config = resolveDynamics()
    const emotions = { ...zero, valence: 20, affinity: 20 }
    expect(decay(emotions, traits({ recovery: 100 }), 7_200_000, config).valence).toBeCloseTo(10)
    expect(decay(emotions, traits({ recovery: 0 }), 7_200_000, config).valence).toBeGreaterThan(10)
  })
  it('查询拆分不改变同一时刻的结果，立场坚持不自动增加怒气', () => {
    const config = resolveDynamics()
    const initial = { ...zero, valence: -30, anger: 35, surprise: 12 }
    const t = traits({ outcome_expect: 35, recovery: -24 })
    const whole = decay(initial, t, 8_000_000, config)
    const split = decay(decay(initial, t, 2_000_000, config), t, 6_000_000, config)
    for (const id of Object.keys(whole) as (keyof Emotions)[]) expect(split[id]).toBeCloseTo(whole[id], 12)
    expect(emotionReaction(traits({ stance_firm: 100 }), feature('conflict'), config)).toEqual(emotionReaction(traits({ stance_firm: -100 }), feature('conflict'), config))
    expect(() => decay(zero, t, -1, config)).toThrow('非负')
  })
  it('none 始终没有事件贡献，调参不会突破非法配置检查', () => {
    expect(emotionReaction(traits({ reactivity: 100 }), feature('conflict', 'present', 'none'), resolveDynamics())).toEqual(zero)
    expect(() => resolveDynamics({ emotionLevels: { none: 1 } })).toThrow('必须为 0')
    expect(() => resolveDynamics({ halfLivesMs: { anger: 0 } })).toThrow()
    expect(() => resolveDynamics({ gainMin: 2, gainMax: 1 })).toThrow()
    expect(() => resolveDynamics({ halfLivesMs: { anger: Number.MAX_VALUE } })).toThrow('溢出')
    expect(() => resolveDynamics({ minTraitEvidence: 65 })).toThrow()
    expect(() => resolveDynamics({ mystery: 1 })).toThrow('未知')
    expect(() => resolveDynamics(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow('未知')
    expect(resolveDynamics({ initialTraits: { social_pref: 80 } }).initialTraits.social_pref).toBe(80)
  })
  it.each([
    ['conflict', 'anger', 5], ['obstruction', 'anger', 2.5], ['threat', 'fear', 5], ['unexpectedness', 'surprise', 5],
  ] as const)('%s 发生时增加 %s，缓解时才减少，历史正负记录保持原解释', (id, axis, expected) => {
    const config = resolveDynamics()
    for (const reactivity of [-100, 0, 100]) {
      const t = traits({ reactivity })
      expect(emotionReaction(t, feature(id, 'present'), config)[axis]).toBeGreaterThan(0)
      expect(emotionReaction(t, feature(id, 'relieved'), config)[axis]).toBeLessThan(0)
      expect(emotionReaction(t, feature(id, 'present'), config)).toEqual(emotionReaction(t, feature(id, 'positive'), config))
      expect(emotionReaction(t, feature(id, 'relieved'), config)).toEqual(emotionReaction(t, feature(id, 'negative'), config))
    }
    expect(emotionReaction(traits(), feature(id, 'present'), config)[axis]).toBe(expected)
  })
})
