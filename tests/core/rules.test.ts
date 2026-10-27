import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MoodStore } from '../../src/host/store.js'
import { DEFAULT_RULES } from '../../src/core/rules.js'
import type { RateRule, TraitId } from '../../src/shared/types.js'

const stores: MoodStore[] = [], folders: string[] = []
afterEach(() => { stores.forEach(s => s.close()); stores.length = 0; folders.forEach(f => rmSync(f, { recursive: true, force: true })); folders.length = 0 })
function setup(path = ':memory:', dynamics?: unknown) {
  let now = 1000, seq = 0
  const store = new MoodStore(path, { dynamics, now: () => now }); stores.push(store)
  const add = () => { const id = `e${++seq}`; store.addEvidence({ id, sessionId: 's', kind: 'user', at: now, text: '真实事件' }); return id }
  const emotion = (id = add(), feature_id = 'conflict', direction = 'present') => store.applyEmotion({ event_id: id, features: [{ feature_id, direction, intensity: 'intense', reason: '实际事件', evidence: [id] }] }, { sessionId: 's', callId: `c${++seq}` })
  const trait = (intensity = 'intense', attribute_id: TraitId = 'explore_pref', direction = 'positive') => store.applyPersonality({ attribute_id, direction, intensity, reason: '一次经历塑造倾向', evidence: [add()] }, { sessionId: 's', callId: `c${++seq}` })
  const rules = (emotion: Partial<RateRule> = {}, personality: Partial<RateRule> = {}) => {
    const old = store.getRules()
    return store.setRules({ expectedRevision: old.revision, emotion: { ...old.emotion, ...emotion }, personality: { ...old.personality, ...personality } })
  }
  return { store, emotion, trait, add, rules, advance: (ms: number) => { now += ms } }
}
function file() { const dir = mkdtempSync(join(tmpdir(), 'mood-rules-')); folders.push(dir); return join(dir, 'db.sqlite') }

it('maps qualitative growth to configured cap and accepts one real event without an emotion update', () => {
  const t = setup()
  expect(t.trait('slight').actualChanges.explore_pref).toBeCloseTo(0.01)
  expect(t.trait('moderate').actualChanges.explore_pref).toBeCloseTo(0.025)
  expect(t.trait('intense').actualChanges.explore_pref).toBeCloseTo(0.05)
  t.rules({}, { perEvent: 0.1 })
  expect(t.trait('moderate').actualChanges.explore_pref).toBeCloseTo(0.05)
})
it('counts absolute movement per attribute and releases it at the rolling boundary', () => {
  const t = setup()
  t.rules({ perEvent: 4, windowMs: 2000, perWindow: 6 }, { perEvent: 0.05, windowMs: 2000, perWindow: 0.075 })
  expect(t.emotion().actualChanges.anger).toBeCloseTo(4)
  expect(t.emotion(undefined, 'conflict', 'relieved').actualChanges.anger).toBe(-2)
  expect(t.emotion().status).toBe('unchanged')
  expect(t.emotion(undefined, 'threat').actualChanges.fear).toBe(4)
  expect(t.trait().actualChanges.explore_pref).toBeCloseTo(0.05)
  expect(t.trait('intense', 'explore_pref', 'negative').actualChanges.explore_pref).toBeCloseTo(-0.025)
  expect(t.trait().status).toBe('unchanged')
  expect(t.trait('intense', 'social_pref').actualChanges.social_pref).toBeCloseTo(0.05)
  t.advance(2000)
  expect(t.emotion().actualChanges.anger).toBeCloseTo(4)
  expect(t.trait().actualChanges.explore_pref).toBeCloseTo(0.05)
})
it('expanding beyond a day includes old usage; shrinking or changing limits never clears usage', () => {
  const t = setup()
  t.emotion()
  t.advance(2 * 86_400_000)
  t.rules({ windowMs: 3 * 86_400_000, perWindow: 10 })
  expect(t.emotion().status).toBe('unchanged')
  t.rules({ perWindow: 12 })
  expect(t.emotion().actualChanges.anger).toBeCloseTo(2)
  t.rules({ perWindow: 5 })
  expect(t.emotion().status).toBe('unchanged')
  t.advance(3 * 86_400_000)
  expect(t.emotion().actualChanges.anger).toBeCloseTo(5)
})
it('rules saved mid-turn apply to delayed tool calls; zero caps pause automatic changes only', () => {
  const t = setup()
  const source = t.add(); t.advance(100)
  t.rules({ perWindow: 0 }, { perEvent: 0 })
  expect(t.emotion(source).status).toBe('unchanged')
  expect(t.trait().status).toBe('unchanged')
  let current = t.store.snapshot()
  t.store.setEmotions({ anger: 50 }, current.version)
  current = t.store.snapshot()
  t.store.setTraits({ recovery: 100 }, current.version)
  t.advance(3_600_000)
  expect(t.store.snapshot().emotions.anger).toBeCloseTo(25)
})
it('persists rules across connections and restarts; only rule edits conflict, not emotion updates', () => {
  const path = file(), a = setup(path), b = setup(path)
  const stale = b.store.getRules()
  a.emotion()
  b.store.setRules({ expectedRevision: stale.revision, emotion: { ...stale.emotion, perEvent: 1 }, personality: stale.personality })
  expect(a.store.config.emotionPerEvent).toBe(1)
  expect(a.emotion().actualChanges.anger).toBeCloseTo(1)
  expect(() => a.store.setRules({ expectedRevision: stale.revision, emotion: stale.emotion, personality: stale.personality })).toThrow('其他页面')
  const saved = b.store.getRules(), version = b.store.snapshot().version
  a.store.close(); b.store.close()
  const c = setup(path, { emotionPerEvent: 99, emotionPerHour: 99 })
  expect(c.store.getRules()).toEqual(saved)
  expect(c.store.snapshot().version).toBe(version)
})
it('validates settings and commits rules, state, configuration and history in one transaction', () => {
  const t = setup(), original = t.store.getRules(), version = t.store.snapshot().version
  for (const invalid of [{ windowMs: 0 }, { windowMs: 0.5 }, { perEvent: -1 }, { perWindow: Infinity }, { unknown: 1 }]) {
    expect(() => t.store.setRules({ expectedRevision: 0, emotion: { ...original.emotion, ...invalid }, personality: original.personality })).toThrow()
  }
  t.store.db.exec("CREATE TRIGGER fail_rules BEFORE UPDATE ON meta WHEN NEW.key='rules' BEGIN SELECT RAISE(ABORT,'test fault'); END")
  expect(() => t.rules({ perEvent: 1 })).toThrow('test fault')
  expect(t.store.getRules()).toEqual(original)
  expect(t.store.snapshot().version).toBe(version)
  expect(t.store.history().items).toEqual([])
})
it('restoring default rules is a normal settings change, not a budget reset', () => {
  const t = setup()
  for (let i = 0; i < 4; i++) t.emotion()
  t.rules({ perWindow: 0 })
  const saved = t.store.setRules({ expectedRevision: t.store.getRules().revision, ...DEFAULT_RULES })
  expect(saved.emotion.perWindow).toBe(40)
  expect(t.emotion().status).toBe('unchanged')
})
it('replays changed windows and revoked events using the rule active at each timestamp', () => {
  const t = setup()
  t.emotion(); const first = t.store.history().items[0]!.id
  t.advance(2 * 86_400_000)
  t.rules({ windowMs: 3 * 86_400_000, perWindow: 10 })
  expect(t.emotion().status).toBe('unchanged')
  t.store.invalidateEvent(first, t.store.snapshot().version)
  expect(t.store.snapshot().emotions.anger).toBeCloseTo(10)
  expect(t.store.history().items.find(e => e.kind === 'emotion' && e.valid)?.actualChanges.anger).toBeCloseTo(10)
})
it('imports old quotas, clamps the old default growth cap, and preserves historical large growth', () => {
  const path = file(), old = setup(path)
  const legacy = { ...old.store.config, traitPerEvent: 0.5, traitPerDay: 1.25, minTraitEvidence: 3, traitLevels: { none: 0, slight: 0.1, moderate: 0.25, intense: 0.5 }, emotionPerHour: 23 }
  old.store.db.prepare('INSERT INTO configs VALUES (?,?)').run('legacy-growth', JSON.stringify(legacy))
  for (const key of ['state', 'origin']) {
    const row = old.store.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string }
    const state = JSON.parse(row.value); state.configVersion = 'legacy-growth'
    old.store.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(state), key)
  }
  expect(old.trait().actualChanges.explore_pref).toBeCloseTo(0.5)
  old.store.db.prepare("DELETE FROM meta WHERE key='rules'").run(); old.store.close()
  const t = setup(path)
  expect(t.store.getRules().emotion.perWindow).toBe(23)
  expect(t.store.getRules().personality).toMatchObject({ perEvent: 0.05, perWindow: 1.25 })
  expect(t.store.snapshot().traits.explore_pref).toBeCloseTo(0.5)
  // New source IDs after reopening the independent connection.
  t.add(); t.add()
  expect(t.trait().actualChanges.explore_pref).toBeCloseTo(0.05)
})
it('preserves schema-v2 manual emotion history and rejects unknown newer databases', () => {
  const path = file(), old = setup(path)
  old.store.setEmotions({ valence: -12.25 }, 0)
  const at = old.store.snapshot().at
  old.store.close()
  const store = new MoodStore(path, { now: () => at }); stores.push(store)
  expect(store.snapshot().emotions.valence).toBe(-12.25)
  expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 })
  store.db.exec('PRAGMA user_version=3'); store.close()
  expect(() => new MoodStore(path)).toThrow('较新版本')
})
