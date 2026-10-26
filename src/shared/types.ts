export const TRAIT_IDS = ['social_pref', 'explore_pref', 'stance_firm', 'intimacy_pref', 'outcome_expect', 'reactivity', 'recovery'] as const
export const EMOTION_IDS = ['valence', 'affinity', 'anger', 'fear', 'surprise'] as const
export const FEATURE_IDS = ['outcome', 'interaction', 'novelty', 'closeness', 'obstruction', 'conflict', 'threat', 'unexpectedness'] as const
export const INTENSITIES = ['none', 'slight', 'moderate', 'intense'] as const

export type TraitId = typeof TRAIT_IDS[number]
export type EmotionId = typeof EMOTION_IDS[number]
export type FeatureId = typeof FEATURE_IDS[number]
export type Intensity = typeof INTENSITIES[number]
export type Direction = 'positive' | 'negative'
export type Traits = Record<TraitId, number>
export type Emotions = Record<EmotionId, number>
export type Features = Record<FeatureId, number>
export type ParameterId = TraitId | EmotionId

export interface ParameterDefinition {
  id: ParameterId
  name: string
  min: number
  max: number
  negative?: string
  zero: string
  positive: string
}

export const TRAIT_DEFINITIONS: readonly ParameterDefinition[] = [
  { id: 'social_pref', name: '社交取向', min: -100, max: 100, negative: '独处', zero: '中性', positive: '互动' },
  { id: 'explore_pref', name: '探索取向', min: -100, max: 100, negative: '熟悉、确定', zero: '中性', positive: '新奇、探索' },
  { id: 'stance_firm', name: '立场坚持', min: -100, max: 100, negative: '调整让步', zero: '中性', positive: '坚持自身判断' },
  { id: 'intimacy_pref', name: '亲密距离', min: -100, max: 100, negative: '保持距离', zero: '中性', positive: '寻求亲近' },
  { id: 'outcome_expect', name: '结果预期', min: -100, max: 100, negative: '悲观', zero: '中性', positive: '乐观' },
  { id: 'reactivity', name: '敏感度', min: -100, max: 100, negative: '反应较弱', zero: '标准', positive: '反应较强' },
  { id: 'recovery', name: '恢复能力', min: -100, max: 100, negative: '余波较久', zero: '标准', positive: '较快回稳' },
]

export const EMOTION_DEFINITIONS: readonly ParameterDefinition[] = [
  { id: 'valence', name: '悲喜', min: -100, max: 100, negative: '悲伤、低落', zero: '中间', positive: '喜悦、满足' },
  { id: 'affinity', name: '好恶', min: -100, max: 100, negative: '厌恶、排斥', zero: '无明显好恶', positive: '喜欢、接纳' },
  { id: 'anger', name: '愤怒', min: 0, max: 100, zero: '无怒气', positive: '强烈愤怒' },
  { id: 'fear', name: '恐惧／焦虑', min: 0, max: 100, zero: '无明显不安', positive: '强烈害怕、担忧' },
  { id: 'surprise', name: '惊讶', min: 0, max: 100, zero: '不惊讶', positive: '强烈意外' },
]

export const FEATURE_LABELS: Record<FeatureId, string> = {
  outcome: '目标结果', interaction: '互动机会', novelty: '新奇程度', closeness: '亲近程度',
  obstruction: '行动受阻', conflict: '冲突冒犯', threat: '威胁风险', unexpectedness: '预期落差',
}

export interface StateSnapshot {
  roleId: string
  version: number
  at: number
  traits: Traits
  emotions: Emotions
  baseline: Emotions
  halfLivesMs: Emotions
  definitions: readonly ParameterDefinition[]
  configVersion: string
}

export interface EmotionFeature {
  feature_id: FeatureId
  direction: Direction
  intensity: Intensity
  reason: string
  evidence: string[]
}
export interface EmotionInput { event_id: string; features: EmotionFeature[] }
export interface TraitInput {
  attribute_id: TraitId
  direction: Direction
  intensity: Intensity
  reason: string
  evidence: string[]
}

export interface Evidence {
  id: string
  sessionId: string
  kind: 'user' | 'tool'
  at: number
  text: string
  traits: Traits
}
export interface CallContext {
  sessionId: string
  callId: string
  /** 仅由当前模型请求实际可见的消息解析别名。 */
  currentUserId?: string
  lastToolId?: string
}

export type MutationStatus = 'applied' | 'unchanged' | 'rejected'
export interface MutationResult {
  status: MutationStatus
  actualChanges: Partial<Record<ParameterId, number>>
  state: StateSnapshot
  reason: string
  limited: string[]
  replayed?: boolean
}

export interface HistoryEntry {
  id: number
  kind: 'emotion' | 'personality' | 'manual' | 'configuration'
  at: number
  committedAt: number
  reason: string
  evidenceIds: string[]
  sourceId?: string
  valid: boolean
  needsReview: boolean
  actualChanges: Partial<Record<ParameterId, number>>
  limited: string[]
}

export interface PromptSnapshot {
  sessionId: string
  turn: number
  at: number
  state: StateSnapshot
  text: string
  templateVersion: number
}

export interface HistoryPage { items: HistoryEntry[]; nextCursor?: number }
export interface TraitEdit { patch: Partial<Traits>; expectedVersion: number }
export interface EventInvalidation { eventId: number; expectedVersion: number; reason?: string }

/** 浏览器只通过这个接口访问宿主，不持有引擎或存储对象。 */
export interface MoodApi {
  getState(): Promise<StateSnapshot>
  listChanges(request: { cursor?: number; limit?: number }): Promise<HistoryPage>
  setTraits(request: TraitEdit): Promise<MutationResult>
  invalidateEvent(request: EventInvalidation): Promise<MutationResult>
  getPromptSnapshot(request: { sessionId: string; turn?: number }): Promise<PromptSnapshot | null>
}
