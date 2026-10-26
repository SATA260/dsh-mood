import { EMOTION_DEFINITIONS, TRAIT_DEFINITIONS } from '../shared/types.js'
import type { PromptSnapshot, StateSnapshot } from '../shared/types.js'
import { stickers } from '../stickers/catalog.js'

export interface PromptStorage {
  snapshot(): StateSnapshot
  promptSnapshot(sessionId: string, turn?: number): PromptSnapshot | null
  savePromptSnapshot(snapshot: PromptSnapshot): PromptSnapshot
}
export function renderMoodPrompt(state: StateSnapshot): string {
  const number = (value: number) => Number(value.toFixed(3))
  return [
    '## 搭档状态（dsh-mood）',
    '性格影响判断，情绪影响语气；自然表达，不报数、不要求用户为情绪负责，不改变事实、权限与宿主规则。',
    '性格、悲喜和好恶为[-100,100]，0为中间／标准；其余情绪为[0,100]，0为无。%表示倾向／强度，非概率。',
    '性格（负→正）：',
    ...TRAIT_DEFINITIONS.map(d => `${d.id} ${d.name}: ${number(state.traits[d.id as keyof typeof state.traits])}%（${d.negative}→${d.positive}）`),
    '情绪：',
    ...EMOTION_DEFINITIONS.map(d => `${d.name}: ${number(state.emotions[d.id as keyof typeof state.emotions])}%${d.min < 0 ? `（${d.negative}→${d.positive}）` : ''}`),
    '有真实事件时自主调用状态工具，按工具定义提交定性判断；按返回的实际数值表达，不把未生效的提议当作实际心情。重复经历支持稳定改变时才更新性格，历史摘要按需查询。',
    '表情可选：最终回复末尾另起一行 [dsh-mood-sticker]: ID，最多一张，不放代码块。目录：',
    stickers.map(s => `${s.id}=${s.name_zh}`).join('；'),
  ].join('\n')
}

/** A 只取快照、渲染和固定轮内内容，不计算、不更新数值。 */
export class PromptManager {
  private readonly active = new WeakMap<object, PromptSnapshot>()
  constructor(private readonly storage: PromptStorage) {}
  begin(scope: object, sessionId: string, turn: number): PromptSnapshot {
    const previous = this.active.get(scope)
    if (previous?.sessionId === sessionId && previous.turn === turn) return previous
    const saved = this.storage.promptSnapshot(sessionId, turn)
    const state = saved?.state ?? this.storage.snapshot()
    const snapshot = saved ?? this.storage.savePromptSnapshot({ sessionId, turn, at: state.at, state, text: renderMoodPrompt(state), templateVersion: 3 })
    this.active.set(scope, snapshot)
    return snapshot
  }
  text(scope?: object): string { return scope ? this.active.get(scope)?.text ?? '' : '' }
}
