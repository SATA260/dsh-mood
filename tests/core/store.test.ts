import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MoodStore } from '../../src/host/store.js'
import { VersionConflict } from '../../src/core/validation.js'
import type { EmotionFeature, FeatureId } from '../../src/shared/types.js'

const opened: MoodStore[] = []
const dirs: string[] = []
afterEach(() => { opened.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
function setup(path = ':memory:', dynamics: unknown = {}) {
  let time = 1_000_000
  let seq = 0
  const store = new MoodStore(path, { now: () => time, dynamics })
  opened.push(store)
  const add = (id = `e${++seq}`, sessionId = 's1') => { store.addEvidence({ id, sessionId, kind: 'user', at: time, text: `事件 ${id}` }); return id }
  const ctx = () => ({ sessionId: 's1', callId: `c${++seq}`, currentUserId: 'current' })
  const emotion = (id: string, feature: FeatureId = 'conflict', direction: 'positive' | 'negative' = 'positive', intensity: EmotionFeature['intensity'] = 'intense') => store.applyEmotion({ event_id: id, features: [{ feature_id: feature, direction, intensity, reason: '实际发生的事件', evidence: [id] }] }, ctx())
  const trait = (ids: string[], attribute_id = 'explore_pref', intensity = 'intense') => store.applyPersonality({ attribute_id, direction: 'positive', intensity, reason: '持续经历形成模式', evidence: ids }, ctx())
  return { store, add, ctx, emotion, trait, advance: (ms: number) => { time += ms }, now: () => time }
}
function file(): string { const dir = mkdtempSync(join(tmpdir(), 'dsh-mood-')); dirs.push(dir); return join(dir, 'state.sqlite') }

describe('持久化与可信变化', () => {
  it('没有工具调用时不自动改变性格或创建变化，只计算自然回稳', () => {
    const t = setup()
    t.add('current')
    t.advance(3_600_000)
    expect(t.store.snapshot().version).toBe(0)
    expect(t.store.history().items).toEqual([])
  })
  it('工具调用与事件分别去重，重复请求不会再次占额度', () => {
    const t = setup()
    const id = t.add()
    const input = { event_id: id, features: [{ feature_id: 'conflict', direction: 'positive', intensity: 'moderate', reason: '冲突', evidence: [id] }] }
    const ctx = t.ctx()
    const first = t.store.applyEmotion(input, ctx)
    expect(first.state.emotions.anger).toBe(5)
    const second = t.store.applyEmotion(input, ctx)
    expect(second.replayed).toBe(true)
    expect(second.state.version).toBe(first.state.version)
    expect(second.state.emotions.anger).toBe(5)
    expect(t.store.applyEmotion(input, t.ctx()).status).toBe('rejected')
    expect(t.store.history().items).toHaveLength(1)
  })
  it('数字、未知字段、未知依据和重复依据都不能绕过校验', () => {
    const t = setup()
    const id = t.add()
    const base = { event_id: id, features: [{ feature_id: 'conflict', direction: 'positive', intensity: 'moderate', reason: '冲突', evidence: [id] }] }
    expect(t.store.applyEmotion({ ...base, delta: 100 }, t.ctx()).status).toBe('rejected')
    expect(t.emotion('invented').status).toBe('rejected')
    expect(t.store.applyEmotion({ ...base, features: [{ ...base.features[0], intensity: 100 }] }, t.ctx()).status).toBe('rejected')
    expect(t.store.applyEmotion({ ...base, features: [base.features[0], base.features[0]] }, t.ctx()).status).toBe('rejected')
    expect(t.trait([id, id, id]).status).toBe('rejected')
    expect(t.store.snapshot().version).toBe(0)
  })
  it('情绪滚动预算按绝对实际变化计入，过窗口后释放', () => {
    const t = setup()
    for (let i = 0; i < 4; i++) expect(t.emotion(t.add()).actualChanges.anger).toBe(10)
    const blocked = t.emotion(t.add())
    expect(blocked.status).toBe('unchanged')
    expect(blocked.limited).toContain('anger')
    expect(t.store.snapshot().emotions.anger).toBe(40)
    t.advance(3_600_001)
    expect(t.emotion(t.add()).actualChanges.anger).toBe(10)
  })
  it('单向轴在边界截断，减少不制造喜悦或负愤怒', () => {
    const t = setup(':memory:', { initialTraits: { reactivity: 100 } })
    expect(t.emotion(t.add(), 'conflict', 'positive', 'slight').actualChanges.anger).toBeCloseTo(3)
    const result = t.emotion(t.add(), 'conflict', 'negative', 'moderate')
    expect(result.actualChanges.anger).toBeCloseTo(-3)
    expect(result.state.emotions.anger).toBe(0)
    expect(result.state.emotions.valence).toBe(0)
  })
  it('性格必须有三项独立依据，同一组依据不能反复领取变化', () => {
    const t = setup()
    const ids = [t.add(), t.add(), t.add()]
    expect(t.trait(ids.slice(0, 2)).status).toBe('rejected')
    expect(t.trait(ids).state.traits.explore_pref).toBe(0.5)
    expect(t.trait([...ids].reverse()).status).toBe('rejected')
    expect(t.trait([...ids, t.add()]).status).toBe('rejected')
    expect(t.store.snapshot().traits.explore_pref).toBe(0.5)
  })
  it('性格一天最多变化三点，内部小数不截断', () => {
    const t = setup()
    for (let i = 0; i < 8; i++) t.trait([t.add(), t.add(), t.add()])
    expect(t.store.snapshot().traits.explore_pref).toBe(3)
    t.advance(86_400_001)
    const result = t.trait([t.add(), t.add(), t.add()], 'explore_pref', 'slight')
    expect(result.state.traits.explore_pref).toBeCloseTo(3.1)
  })
  it('手动修改先结算旧参数，保留情绪连续并只修改提交项', () => {
    const t = setup()
    t.trait([t.add(), t.add(), t.add()], 'explore_pref', 'moderate')
    t.emotion(t.add())
    t.advance(3_600_000)
    const before = t.store.snapshot()
    const saved = t.store.setTraits({ recovery: 100, outcome_expect: 80 }, before.version)
    expect(saved.state.emotions).toEqual(before.emotions)
    expect(saved.state.traits.explore_pref).toBe(0.25)
    expect(saved.state.baseline.valence).toBe(16)
    expect(() => t.store.setTraits({ social_pref: 80 }, before.version)).toThrow(VersionConflict)
    t.advance(3_600_000)
    expect(t.store.snapshot().emotions.anger).toBeCloseTo(before.emotions.anger / 2)
  })
  it('重启保留状态，新的初始配置不覆盖已成长的性格', () => {
    const path = file()
    const a = setup(path)
    a.store.setTraits({ social_pref: 35 }, a.store.snapshot().version)
    a.store.close()
    const b = setup(path, { initialTraits: { social_pref: -100 } })
    expect(b.store.snapshot().traits.social_pref).toBe(35)
  })
  it('计算参数改动仅影响之后的时间，不用新半衰期重算过去', () => {
    const path = file()
    let time = 0
    const a = new MoodStore(path, { now: () => time }); opened.push(a)
    a.addEvidence({ id: 'e', sessionId: 's', kind: 'user', at: time, text: '冲突' })
    a.applyEmotion({ event_id: 'e', features: [{ feature_id: 'conflict', direction: 'positive', intensity: 'intense', reason: '冲突', evidence: ['e'] }] }, { sessionId: 's', callId: '1' })
    time = 7_200_000
    a.close()
    const b = new MoodStore(path, { now: () => time, dynamics: { halfLivesMs: { anger: 3_600_000 } } }); opened.push(b)
    expect(b.snapshot().emotions.anger).toBeCloseTo(5)
    time += 3_600_000
    expect(b.snapshot().emotions.anger).toBeCloseTo(2.5)
  })
  it('历史撤销重算余波和后续预算，不能直接减掉旧增量', () => {
    const t = setup()
    t.emotion(t.add('first'))
    const first = t.store.history().items[0]!
    t.advance(3_600_000)
    t.emotion(t.add('second'))
    t.advance(3_600_000)
    const result = t.store.invalidateEvent(first.id, t.store.snapshot().version)
    expect(result.state.emotions.anger).toBeCloseTo(10 / Math.sqrt(2))
    expect(t.store.history().items.find(e => e.id === first.id)?.valid).toBe(false)
  })
  it('撤销释放的额度可改变后续历史判断，关联性格依据被标记', () => {
    const t = setup()
    const first = t.add('first')
    t.emotion(first)
    const firstId = t.store.history().items[0]!.id
    for (let i = 0; i < 4; i++) t.emotion(t.add())
    t.trait([first, t.add(), t.add()])
    const result = t.store.invalidateEvent(firstId, t.store.snapshot().version)
    expect(result.state.emotions.anger).toBe(40)
    expect(t.store.history().items.find(e => e.kind === 'personality')?.needsReview).toBe(true)
  })
  it('延迟提交使用事件发生时的性格，不受工具调用顺序篡改', () => {
    const t = setup(':memory:', { initialTraits: { social_pref: 80 } })
    const event = t.add()
    t.advance(10)
    t.store.setTraits({ social_pref: -80 }, t.store.snapshot().version)
    const result = t.emotion(event, 'interaction', 'positive', 'moderate')
    expect(result.actualChanges.valence).toBeCloseTo(4)
    expect(result.state.traits.social_pref).toBe(-80)
    expect(result.state.emotions.valence).toBeGreaterThan(3.9)
  })
  it('不同连接读到最新状态，旧版本保存不会丢失其他聊天更新', () => {
    const path = file()
    const a = setup(path)
    const b = setup(path)
    const old = a.store.snapshot()
    b.store.setTraits({ explore_pref: 80 }, old.version)
    expect(a.store.snapshot().traits.explore_pref).toBe(80)
    expect(() => a.store.setTraits({ social_pref: 50 }, old.version)).toThrow(VersionConflict)
    a.store.setTraits({ social_pref: 50 }, a.store.snapshot().version)
    expect(b.store.snapshot().traits.explore_pref).toBe(80)
    expect(b.store.snapshot().traits.social_pref).toBe(50)
  })
  it('提交失败会同时回滚状态、历史和幂等记录', () => {
    const t = setup()
    const e = t.add()
    t.store.db.exec("CREATE TRIGGER fail_call BEFORE INSERT ON calls BEGIN SELECT RAISE(ABORT,'simulated failure'); END")
    expect(() => t.emotion(e)).toThrow('simulated failure')
    expect(t.store.snapshot().version).toBe(0)
    expect(t.store.snapshot().emotions.anger).toBe(0)
    expect(t.store.history().items).toEqual([])
    t.store.db.exec('DROP TRIGGER fail_call')
    expect(t.emotion(e).status).toBe('applied')
  })
  it('损坏的数据不能被当成首次启动后重置', () => {
    const path = file()
    writeFileSync(path, 'broken data')
    expect(() => new MoodStore(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('broken data')
  })
})
