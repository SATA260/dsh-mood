import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { baseline, clamp, decay, emotionReaction, halfLives } from '../core/math.js'
import { resolveDynamics } from '../core/config.js'
import type { DynamicsConfig } from '../core/config.js'
import { InputError, parseEmotion, parseTrait, parseTraitPatch, VersionConflict } from '../core/validation.js'
import { EMOTION_DEFINITIONS, EMOTION_IDS, TRAIT_DEFINITIONS, TRAIT_IDS } from '../shared/types.js'
import type { CallContext, EmotionInput, Emotions, Evidence, HistoryEntry, HistoryPage, MutationResult, ParameterId, PromptSnapshot, StateSnapshot, TraitInput, Traits } from '../shared/types.js'

interface EngineState { at: number; traits: Traits; emotions: Emotions; configVersion: string }
interface Projection { after: EngineState; actualChanges: Partial<Record<ParameterId, number>>; limited: string[] }
interface CommandRow {
  id: number
  kind: HistoryEntry['kind']
  effective_at: number
  committed_at: number
  payload: string
  evidence_ids: string
  source_id: string | null
  reason: string
  valid: number
  needs_review: number
  projection: string | null
}
interface EmotionPayload { input: EmotionInput; sourceTraits: Traits }
interface TraitPayload { input: TraitInput }
interface BudgetItem { at: number; kind: string; changes: Partial<Record<ParameterId, number>> }
type DbRow = Record<string, unknown>

// A formula change must introduce a new rule version and a replay migration.
function configHash(config: DynamicsConfig): string { return `v1-${createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20)}` }
function parse<T>(text: string): T { return JSON.parse(text) as T }
function delta(before: StateSnapshot, after: StateSnapshot): Partial<Record<ParameterId, number>> {
  const result: Partial<Record<ParameterId, number>> = {}
  for (const id of TRAIT_IDS) if (before.traits[id] !== after.traits[id]) result[id] = after.traits[id] - before.traits[id]
  for (const id of EMOTION_IDS) if (before.emotions[id] !== after.emotions[id]) result[id] = after.emotions[id] - before.emotions[id]
  return result
}

/** profile 内唯一的状态写入者；SQLite 事务同时提交状态、预算和幂等结果。 */
export class MoodStore {
  readonly db: DatabaseSync
  readonly config: DynamicsConfig
  readonly configVersion: string
  private readonly now: () => number
  private readonly listeners = new Set<(state: StateSnapshot) => void>()
  private closed = false

  constructor(path: string, options: { dynamics?: unknown; now?: () => number; busyTimeoutMs?: number } = {}) {
    this.config = resolveDynamics(options.dynamics)
    this.configVersion = configHash(this.config)
    this.now = options.now ?? Date.now
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { timeout: options.busyTimeoutMs ?? 5000 })
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
      const version = this.db.prepare('PRAGMA user_version').get() as DbRow
      if (Number(version.user_version) > 1) throw new Error('状态数据库来自较新版本，无法打开；原数据未修改。')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS configs (version TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, at REAL NOT NULL, text TEXT NOT NULL, traits TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS commands (
          id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, effective_at REAL NOT NULL,
          committed_at REAL NOT NULL, payload TEXT NOT NULL, evidence_ids TEXT NOT NULL,
          source_id TEXT UNIQUE, pattern_key TEXT UNIQUE, reason TEXT NOT NULL,
          valid INTEGER NOT NULL DEFAULT 1, needs_review INTEGER NOT NULL DEFAULT 0, projection TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS commands_time ON commands(effective_at,id);
        CREATE TABLE IF NOT EXISTS calls (key TEXT PRIMARY KEY, result TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS prompt_snapshots (session_id TEXT NOT NULL, turn INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,turn)) STRICT;
        CREATE TABLE IF NOT EXISTS invalidations (id INTEGER PRIMARY KEY, command_id INTEGER NOT NULL REFERENCES commands(id), at REAL NOT NULL, reason TEXT NOT NULL) STRICT;
        PRAGMA user_version=1;
      `)
      this.transaction(() => {
        this.db.prepare('INSERT OR IGNORE INTO configs VALUES (?,?)').run(this.configVersion, JSON.stringify(this.config))
        if (!this.meta('state')) {
          const state: EngineState = { at: this.now(), traits: structuredClone(this.config.initialTraits), emotions: baseline(this.config.initialTraits, this.config), configVersion: this.configVersion }
          this.putMeta('origin', state)
          this.putMeta('state', state)
          this.putMeta('version', 0)
        } else {
          this.readState()
          const previous = this.readState()
          if (previous.configVersion !== this.configVersion) {
            const id = this.insertCommand('configuration', Math.max(this.now(), previous.at), { configVersion: this.configVersion }, [], '计算配置变更')
            this.recompute(id)
            this.bumpVersion()
          }
        }
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    this.db.close()
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value
  }
  private putMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
  }
  private version(): number {
    const value = Number(this.meta('version'))
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('状态版本损坏；未重置数据库。')
    return value
  }
  private bumpVersion(): void { this.putMeta('version', this.version() + 1) }
  private readState(raw = this.meta('state')): EngineState {
    if (!raw) throw new Error('缺少已初始化的角色状态')
    const state = parse<EngineState>(raw)
    try {
      parseTraitPatch(state.traits)
      if (TRAIT_IDS.some(id => !Object.hasOwn(state.traits, id))) throw new Error('缺少性格属性')
    } catch (cause) { throw new Error('性格状态损坏；未重置数据库。', { cause }) }
    if (!Number.isFinite(state.at) || !state.configVersion) throw new Error('状态时间或配置版本损坏')
    for (const id of EMOTION_IDS) if (typeof state.emotions[id] !== 'number' || !Number.isFinite(state.emotions[id]) || state.emotions[id] < (id === 'valence' || id === 'affinity' ? -100 : 0) || state.emotions[id] > 100) throw new Error('情绪状态损坏；未将其视为零值。')
    return state
  }
  private loadConfig(version: string): DynamicsConfig {
    const row = this.db.prepare('SELECT value FROM configs WHERE version=?').get(version) as { value: string } | undefined
    if (!row) throw new Error(`缺少历史计算配置 ${version}`)
    return resolveDynamics(parse<unknown>(row.value))
  }

  snapshot(at = this.now()): StateSnapshot {
    // One SQLite statement pins state and version to the same read snapshot,
    // including when another host process commits between JavaScript calls.
    const row = this.db.prepare("SELECT (SELECT value FROM meta WHERE key='state') AS state, (SELECT value FROM meta WHERE key='version') AS version").get() as { state: string; version: string }
    const state = this.readState(row.state)
    const version = Number(row.version)
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('状态版本损坏；未重置数据库。')
    const time = Math.max(at, state.at)
    if (!Number.isFinite(time)) throw new InputError('无效的快照时间')
    const config = this.loadConfig(state.configVersion)
    return {
      roleId: 'companion', version, at: time, traits: structuredClone(state.traits),
      emotions: decay(state.emotions, state.traits, time - state.at, config),
      baseline: baseline(state.traits, config), halfLivesMs: halfLives(state.traits, config),
      definitions: structuredClone([...TRAIT_DEFINITIONS, ...EMOTION_DEFINITIONS]), configVersion: state.configVersion,
    }
  }

  addEvidence(input: Omit<Evidence, 'traits'>): void {
    if (!input.id || !input.sessionId || !['user', 'tool'].includes(input.kind) || !Number.isFinite(input.at)) throw new InputError('无效的宿主证据记录')
    this.transaction(() => {
    const old = this.getEvidence(input.id)
    if (old) {
      if (old.sessionId !== input.sessionId || old.kind !== input.kind || old.text !== input.text.slice(0, 2000)) throw new InputError('证据 ID 已对应另一条宿主记录')
      return
    }
    const origin = parse<EngineState>(this.meta('origin')!)
    const at = Math.max(input.at, origin.at)
    const traits = this.traitsAt(at)
    this.db.prepare('INSERT OR IGNORE INTO evidence VALUES (?,?,?,?,?,?)').run(input.id, input.sessionId, input.kind, at, input.text.slice(0, 2000), JSON.stringify(traits))
    })
  }

  private traitsAt(at: number): Traits {
    const row = this.db.prepare('SELECT projection FROM commands WHERE effective_at<=? AND projection IS NOT NULL ORDER BY effective_at DESC,id DESC LIMIT 1').get(at) as { projection: string } | undefined
    return structuredClone(row ? parse<Projection>(row.projection).after.traits : parse<EngineState>(this.meta('origin')!).traits)
  }
  getEvidence(id: string): Evidence | undefined {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id=?').get(id) as { id: string; session_id: string; kind: Evidence['kind']; at: number; text: string; traits: string } | undefined
    return row ? { id: row.id, sessionId: row.session_id, kind: row.kind, at: row.at, text: row.text, traits: parse<Traits>(row.traits) } : undefined
  }
  recentEvidence(limit = 32): Evidence[] {
    const rows = this.db.prepare('SELECT id FROM evidence ORDER BY at DESC,rowid DESC LIMIT ?').all(limit) as { id: string }[]
    return rows.map(row => this.getEvidence(row.id)!)
  }
  private resolveEvidence(reference: string, ctx: CallContext): Evidence {
    const id = reference === 'current_user_message' ? ctx.currentUserId : reference === 'last_tool_result' ? ctx.lastToolId : reference
    const found = id ? this.getEvidence(id) : undefined
    if (!found) throw new InputError(`找不到模型可引用的宿主依据：${reference}`)
    return found
  }
  private resolveEvidenceIds(references: string[], ctx: CallContext): string[] {
    const ids = references.map(ref => this.resolveEvidence(ref, ctx).id)
    if (new Set(ids).size !== ids.length) throw new InputError('多个依据实际指向同一事件，不能重复计数')
    return ids
  }

  private insertCommand(kind: HistoryEntry['kind'], at: number, payload: unknown, evidenceIds: string[], reason: string, sourceId?: string, patternKey?: string): number {
    const result = this.db.prepare('INSERT INTO commands(kind,effective_at,committed_at,payload,evidence_ids,source_id,pattern_key,reason) VALUES (?,?,?,?,?,?,?,?)')
      .run(kind, at, this.now(), JSON.stringify(payload), JSON.stringify(evidenceIds), sourceId ?? null, patternKey ?? null, reason)
    return Number(result.lastInsertRowid)
  }

  /** 从受影响位置的前一检查点复算；普通顺序写入只重算新增记录。 */
  private recompute(changedId: number): Projection {
    const changed = this.db.prepare('SELECT * FROM commands WHERE id=?').get(changedId) as unknown as CommandRow
    const previous = this.db.prepare('SELECT * FROM commands WHERE (effective_at<? OR (effective_at=? AND id<?)) AND projection IS NOT NULL ORDER BY effective_at DESC,id DESC LIMIT 1')
      .get(changed.effective_at, changed.effective_at, changed.id) as unknown as CommandRow | undefined
    let state = structuredClone(previous ? parse<Projection>(previous.projection!).after : parse<EngineState>(this.meta('origin')!))
    let config = this.loadConfig(state.configVersion)
    const priorRows = this.db.prepare('SELECT kind,effective_at,projection FROM commands WHERE effective_at>=? AND (effective_at<? OR (effective_at=? AND id<?)) AND projection IS NOT NULL')
      .all(changed.effective_at - 86_400_000, changed.effective_at, changed.effective_at, changed.id) as { kind: string; effective_at: number; projection: string }[]
    const budget: BudgetItem[] = priorRows.map(row => ({ at: row.effective_at, kind: row.kind, changes: parse<Projection>(row.projection).actualChanges }))
    const rows = this.db.prepare('SELECT * FROM commands WHERE effective_at>? OR (effective_at=? AND id>=?) ORDER BY effective_at,id')
      .all(changed.effective_at, changed.effective_at, changed.id) as unknown as CommandRow[]
    let changedProjection: Projection | undefined
    const update = this.db.prepare('UPDATE commands SET projection=? WHERE id=?')
    for (const row of rows) {
      state.emotions = decay(state.emotions, state.traits, row.effective_at - state.at, config)
      state.at = row.effective_at
      const changes: Projection['actualChanges'] = {}
      const limited: string[] = []
      const used = (kind: string, id: ParameterId, window: number): number => budget.reduce((sum, item) => item.kind === kind && item.at > row.effective_at - window ? sum + Math.abs(item.changes[id] ?? 0) : sum, 0)
      if (row.valid && row.kind === 'emotion') {
        const payload = parse<EmotionPayload>(row.payload)
        const reaction = emotionReaction(payload.sourceTraits, payload.input.features, config)
        for (const id of EMOTION_IDS) {
          const remaining = Math.min(config.emotionPerEvent, Math.max(0, config.emotionPerHour - used('emotion', id, 3_600_000)))
          const before = state.emotions[id]
          const after = clamp(before + clamp(reaction[id], -remaining, remaining), id === 'valence' || id === 'affinity' ? -100 : 0, 100)
          const actual = after - before
          if (actual !== 0) changes[id] = actual
          if (Math.abs(actual - reaction[id]) > 1e-10) limited.push(id)
          state.emotions[id] = after
        }
      } else if (row.valid && row.kind === 'personality') {
        const { input } = parse<TraitPayload>(row.payload)
        const id = input.attribute_id
        const raw = (input.direction === 'positive' ? 1 : -1) * config.traitLevels[input.intensity]
        const remaining = Math.min(config.traitPerEvent, Math.max(0, config.traitPerDay - used('personality', id, 86_400_000)))
        const actual = clamp(state.traits[id] + clamp(raw, -remaining, remaining), -100, 100) - state.traits[id]
        state.traits[id] += actual
        if (actual !== 0) changes[id] = actual
        if (Math.abs(actual - raw) > 1e-10) limited.push(id)
      } else if (row.valid && row.kind === 'manual') {
        const { patch } = parse<{ patch: Partial<Traits> }>(row.payload)
        for (const id of TRAIT_IDS) {
          const value = patch[id]
          if (value !== undefined && value !== state.traits[id]) { changes[id] = value - state.traits[id]; state.traits[id] = value }
        }
      } else if (row.valid && row.kind === 'configuration') {
        state.configVersion = parse<{ configVersion: string }>(row.payload).configVersion
        config = this.loadConfig(state.configVersion)
      }
      const projection: Projection = { after: structuredClone(state), actualChanges: changes, limited }
      update.run(JSON.stringify(projection), row.id)
      if (row.id === changedId) changedProjection = projection
      budget.push({ at: row.effective_at, kind: row.kind, changes })
    }
    this.putMeta('state', state)
    if (!changedProjection) throw new Error('缺少变化检查点')
    return changedProjection
  }

  private result(status: MutationResult['status'], reason: string, changes: MutationResult['actualChanges'] = {}, limited: string[] = []): MutationResult {
    return { status, actualChanges: changes, state: this.snapshot(), reason, limited }
  }

  private applyCall(ctx: CallContext, apply: () => MutationResult): MutationResult {
    if (!ctx.sessionId || !ctx.callId) throw new InputError('工具调用缺少宿主身份')
    const key = JSON.stringify([ctx.sessionId, ctx.callId])
    let notify = false
    const result = this.transaction(() => {
      const existing = this.db.prepare('SELECT result FROM calls WHERE key=?').get(key) as { result: string } | undefined
      if (existing) return { ...parse<MutationResult>(existing.result), state: this.snapshot(), replayed: true }
      let response: MutationResult
      try { response = apply(); notify = response.status !== 'rejected' }
      catch (error) {
        if (!(error instanceof InputError)) throw error
        response = this.result('rejected', error.message)
      }
      this.db.prepare('INSERT INTO calls VALUES (?,?)').run(key, JSON.stringify(response))
      return response
    })
    if (notify) this.publish()
    return result
  }

  applyEmotion(input: unknown, ctx: CallContext): MutationResult {
    return this.applyCall(ctx, () => {
      const proposal = parseEmotion(input)
      const source = this.resolveEvidence(proposal.event_id, ctx)
      if (this.db.prepare('SELECT id FROM commands WHERE source_id=?').get(source.id)) throw new InputError('该事件的情绪判断已经处理，不能再次增减。')
      const evidenceIds = new Set<string>()
      for (const feature of proposal.features) {
        feature.evidence = this.resolveEvidenceIds(feature.evidence, ctx)
        if (!feature.evidence.includes(source.id)) throw new InputError('每项特征必须包含本次事件的依据')
        feature.evidence.forEach(id => evidenceIds.add(id))
      }
      proposal.event_id = source.id
      const id = this.insertCommand('emotion', source.at, { input: proposal, sourceTraits: source.traits } satisfies EmotionPayload, [...evidenceIds], proposal.features.map(f => f.reason).join('；'), source.id)
      const projection = this.recompute(id)
      this.bumpVersion()
      return this.result(Object.keys(projection.actualChanges).length ? 'applied' : 'unchanged', projection.limited.length ? '已按剩余额度与数值边界保存。' : '已保存本次情绪变化。', projection.actualChanges, projection.limited)
    })
  }

  applyPersonality(input: unknown, ctx: CallContext): MutationResult {
    return this.applyCall(ctx, () => {
      const proposal = parseTrait(input)
      proposal.evidence = this.resolveEvidenceIds(proposal.evidence, ctx)
      if (proposal.evidence.length < this.config.minTraitEvidence) throw new InputError(`性格慢变至少需要 ${this.config.minTraitEvidence} 个不同事件支持。`)
      const patternKey = JSON.stringify([proposal.attribute_id, [...proposal.evidence].sort()])
      if (this.db.prepare('SELECT id FROM commands WHERE pattern_key=?').get(patternKey)) throw new InputError('这组性格依据已经使用，不能重复累加。')
      const used = this.db.prepare("SELECT evidence_ids FROM commands WHERE kind='personality' AND json_extract(payload,'$.input.attribute_id')=?").all(proposal.attribute_id) as { evidence_ids: string }[]
      const usedIds = new Set(used.flatMap(row => parse<string[]>(row.evidence_ids)))
      if (proposal.evidence.some(id => usedIds.has(id))) throw new InputError('这个属性已使用其中的依据；需要至少三个尚未用于该属性的不同事件。')
      const at = Math.max(this.now(), this.readState().at)
      const id = this.insertCommand('personality', at, { input: proposal } satisfies TraitPayload, proposal.evidence, proposal.reason, undefined, patternKey)
      const projection = this.recompute(id)
      this.bumpVersion()
      return this.result(Object.keys(projection.actualChanges).length ? 'applied' : 'unchanged', projection.limited.length ? '已按性格慢变额度保存。' : '已保存性格慢变。', projection.actualChanges, projection.limited)
    })
  }

  setTraits(patchInput: unknown, expectedVersion: number): MutationResult {
    const patch = parseTraitPatch(patchInput)
    const response = this.transaction(() => {
      if (expectedVersion !== this.version()) throw new VersionConflict()
      const before = this.snapshot()
      if (Object.entries(patch).every(([id, value]) => before.traits[id as keyof Traits] === value)) return this.result('unchanged', '性格没有变化。')
      const id = this.insertCommand('manual', before.at, { patch }, [], '用户手动修改性格')
      const projection = this.recompute(id)
      this.bumpVersion()
      return this.result('applied', '已保存；当前情绪保持连续，之后按新性格回稳。', projection.actualChanges)
    })
    if (response.status === 'applied') this.publish()
    return response
  }

  invalidateEvent(eventId: number, expectedVersion: number, reason = '用户纠正：这次理解错了'): MutationResult {
    const response = this.transaction(() => {
      if (expectedVersion !== this.version()) throw new VersionConflict()
      const row = this.db.prepare('SELECT * FROM commands WHERE id=?').get(eventId) as unknown as CommandRow | undefined
      if (!row || row.kind !== 'emotion') throw new InputError('只能撤销已有的情绪判断')
      if (!row.valid) return this.result('unchanged', '这次情绪判断已撤销。')
      const before = this.snapshot()
      this.db.prepare('UPDATE commands SET valid=0 WHERE id=?').run(eventId)
      this.db.prepare('INSERT INTO invalidations(command_id,at,reason) VALUES (?,?,?)').run(eventId, this.now(), reason)
      const linked = this.db.prepare("SELECT id,evidence_ids FROM commands WHERE kind='personality'").all() as { id: number; evidence_ids: string }[]
      for (const trait of linked) if (row.source_id && parse<string[]>(trait.evidence_ids).includes(row.source_id)) this.db.prepare('UPDATE commands SET needs_review=1 WHERE id=?').run(trait.id)
      this.recompute(eventId)
      this.bumpVersion()
      return this.result('applied', '已撤销并重算情绪时间线；相关性格依据已标记复核。', delta(before, this.snapshot()))
    })
    if (response.status === 'applied') this.publish()
    return response
  }

  history(cursor?: number, limit = 20): HistoryPage {
    const count = Math.min(100, Math.max(1, Math.floor(limit)))
    const rows = this.db.prepare('SELECT * FROM commands WHERE id<? ORDER BY id DESC LIMIT ?').all(cursor ?? Number.MAX_SAFE_INTEGER, count + 1) as unknown as CommandRow[]
    const items: HistoryEntry[] = rows.slice(0, count).map(row => {
      const projection = row.projection ? parse<Projection>(row.projection) : undefined
      return { id: row.id, kind: row.kind, at: row.effective_at, committedAt: row.committed_at, reason: row.reason,
        evidenceIds: parse<string[]>(row.evidence_ids), ...(row.source_id ? { sourceId: row.source_id } : {}),
        valid: Boolean(row.valid), needsReview: Boolean(row.needs_review), actualChanges: projection?.actualChanges ?? {}, limited: projection?.limited ?? [] }
    })
    return { items, ...(rows.length > count ? { nextCursor: items.at(-1)!.id } : {}) }
  }

  savePromptSnapshot(value: PromptSnapshot): PromptSnapshot {
    this.db.prepare('INSERT OR IGNORE INTO prompt_snapshots VALUES (?,?,?)').run(value.sessionId, value.turn, JSON.stringify(value))
    return this.promptSnapshot(value.sessionId, value.turn)!
  }
  promptSnapshot(sessionId: string, turn?: number): PromptSnapshot | null {
    const row = (turn === undefined
      ? this.db.prepare('SELECT value FROM prompt_snapshots WHERE session_id=? ORDER BY turn DESC LIMIT 1').get(sessionId)
      : this.db.prepare('SELECT value FROM prompt_snapshots WHERE session_id=? AND turn=?').get(sessionId, turn)) as { value: string } | undefined
    return row ? parse<PromptSnapshot>(row.value) : null
  }
  subscribe(listener: (state: StateSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(): void {
    const state = this.snapshot()
    for (const listener of this.listeners) {
      try { listener(structuredClone(state)) }
      catch (error) { console.warn('[dsh-mood] 状态已提交，订阅者处理失败：', error) }
    }
  }
}
