/** Shared strict Host/Client contract, assembled with the pinned Typert runtime. */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { RemoteResult, RemoteStreamHandle, TypertRemoteMethodSpec } from '@deepseek-ai/dsh-typert-protocol'
import { EMOTION_IDS, TRAIT_IDS } from './shared/types.js'
import type { EventInvalidation, HistoryPage, MutationResult, PromptSnapshot, StateSnapshot, TraitEdit } from './shared/types.js'

const finite = z.number().finite()
const trait = finite.min(-100).max(100)
const traits = z.object({ social_pref: trait, explore_pref: trait, stance_firm: trait, intimacy_pref: trait, outcome_expect: trait, reactivity: trait, recovery: trait }).strict()
const emotions = z.object({ valence: trait, affinity: trait, anger: finite.min(0).max(100), fear: finite.min(0).max(100), surprise: finite.min(0).max(100) }).strict()
const positive = finite.positive()
const halfLives = z.object({ valence: positive, affinity: positive, anger: positive, fear: positive, surprise: positive }).strict()
const version = z.number().int().nonnegative()
const definition = z.object({ id: z.enum([...TRAIT_IDS, ...EMOTION_IDS]), name: z.string(), min: finite, max: finite, negative: z.string().optional(), zero: z.string(), positive: z.string() })
export const stateSchema: z.ZodType<StateSnapshot> = z.object({ roleId: z.string(), version, at: finite, traits, emotions, baseline: emotions, halfLivesMs: halfLives, definitions: z.array(definition), configVersion: z.string() })
const changes = z.partialRecord(z.enum([...TRAIT_IDS, ...EMOTION_IDS]), finite)
const mutation: z.ZodType<MutationResult> = z.object({ status: z.enum(['applied', 'unchanged', 'rejected']), actualChanges: changes, state: stateSchema, reason: z.string(), limited: z.array(z.string()), replayed: z.boolean().optional() })
const history: z.ZodType<HistoryPage> = z.object({ items: z.array(z.object({ id: z.number().int().positive(), kind: z.enum(['emotion', 'personality', 'manual', 'configuration']), at: finite, committedAt: finite, reason: z.string(), evidenceIds: z.array(z.string()), sourceId: z.string().optional(), valid: z.boolean(), needsReview: z.boolean(), actualChanges: changes, limited: z.array(z.string()) })), nextCursor: z.number().int().positive().optional() })
const snapshot: z.ZodType<PromptSnapshot | null> = z.object({ sessionId: z.string(), turn: version, at: finite, state: stateSchema, text: z.string(), templateVersion: version }).nullable()
const codec = (name: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol: `dsh-mood#${name}`, create: () => schema })
function method(name: string, result: z.ZodType, request?: z.ZodType): TypertRemoteMethodSpec {
  const parameter = request && { name: 'request', source: 'json' as const, codec: codec(`${name}.request`, request), strictCodec: codec(`${name}.request`, request) }
  return { service: 'mood', invocation: { kind: 'direct' }, parameters: parameter ? [parameter] : [], result: codec(`${name}.result`, result) }
}
export const TYPERT_REMOTE = createTypertRemoteInfo({ package: 'dsh-mood', methods: {
  'mood/getState': method('getState', stateSchema),
  'mood/listChanges': method('listChanges', history, z.object({ cursor: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).optional() }).strict()),
  'mood/setTraits': method('setTraits', mutation, z.object({ patch: traits.partial(), expectedVersion: version }).strict()),
  'mood/invalidateEvent': method('invalidateEvent', mutation, z.object({ eventId: z.number().int().positive(), expectedVersion: version, reason: z.string().max(2000).optional() }).strict()),
  'mood/getPromptSnapshot': method('getPromptSnapshot', snapshot, z.object({ sessionId: z.string().min(1), turn: version.optional() }).strict()),
  'mood/watchState': { ...method('watchState', stateSchema), mode: 'stream', cancellation: { parameter: 'signal' } },
} }, z)

export interface MoodRemote {
  getState(): Promise<RemoteResult<StateSnapshot>>
  listChanges(request: { cursor?: number; limit?: number }): Promise<RemoteResult<HistoryPage>>
  setTraits(request: TraitEdit): Promise<RemoteResult<MutationResult>>
  invalidateEvent(request: EventInvalidation): Promise<RemoteResult<MutationResult>>
  getPromptSnapshot(request: { sessionId: string; turn?: number }): Promise<RemoteResult<PromptSnapshot | null>>
  watchState(): RemoteStreamHandle<StateSnapshot, never>
}
declare module '@deepseek-ai/dsh-typert-protocol' { interface TypertRemoteNamespaceMap { mood: MoodRemote } }
export default TYPERT_REMOTE
