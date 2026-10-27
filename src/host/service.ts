import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type { MoodStore } from './store.js'
import type { EmotionEdit, EventInvalidation, HistoryPage, MutationResult, PromptSnapshot, RulesSnapshot, RulesUpdate, StateSnapshot, TraitEdit } from '../shared/types.js'

declare module '@deepseek-ai/cordis' { interface Context { mood: MoodService } }

/** @typert service mood */
export class MoodService extends TypertRemoteService {
  private readonly store: MoodStore
  private readonly lifetime = new AbortController()
  constructor(ctx: Context, config: { store: MoodStore }) {
    super(ctx, 'mood'); this.store = config.store
    ctx.effect(() => () => this.lifetime.abort())
  }
  @Remote
  getState(): StateSnapshot { return this.store.snapshot() }
  @Remote
  getRules(): RulesSnapshot { return this.store.getRules() }
  @Remote
  setRules(request: RulesUpdate): RulesSnapshot { return this.store.setRules(request) }
  @Remote
  listChanges(request: { cursor?: number; limit?: number }): HistoryPage {
    if (request.cursor !== undefined && (!Number.isSafeInteger(request.cursor) || request.cursor <= 0)) throw new Error('无效历史游标')
    if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)) throw new Error('历史条数应为1至100')
    return this.store.history(request.cursor, request.limit)
  }
  @Remote
  setTraits(request: TraitEdit): MutationResult { return this.store.setTraits(request.patch, request.expectedVersion) }
  @Remote
  setEmotions(request: EmotionEdit): MutationResult { return this.store.setEmotions(request.patch, request.expectedVersion) }
  @Remote
  invalidateEvent(request: EventInvalidation): MutationResult {
    if (!Number.isSafeInteger(request.eventId) || request.eventId < 1 || (request.reason?.length ?? 0) > 2000) throw new Error('无效事件撤销参数')
    return this.store.invalidateEvent(request.eventId, request.expectedVersion, request.reason)
  }
  @Remote
  getPromptSnapshot(request: { sessionId: string; turn?: number }): PromptSnapshot | null {
    if (!request.sessionId || (request.turn !== undefined && (!Number.isSafeInteger(request.turn) || request.turn < 0))) throw new Error('无效会话快照参数')
    return this.store.promptSnapshot(request.sessionId, request.turn)
  }
  @Remote({ mode: 'stream' })
  async *watchState(signal: AbortSignal): RemoteStream<StateSnapshot> {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    let pending: StateSnapshot | undefined = this.store.snapshot()
    let wake: (() => void) | undefined
    const unsubscribe = this.store.subscribe(state => { pending = state; wake?.() })
    const stop = () => wake?.()
    signal.addEventListener('abort', stop, { once: true })
    try {
      while (!signal.aborted) {
        if (pending) { const state = pending; pending = undefined; yield state }
        else await new Promise<void>(resolve => { wake = resolve; if (signal.aborted) resolve() })
      }
    } finally { unsubscribe(); signal.removeEventListener('abort', stop) }
  }
}
