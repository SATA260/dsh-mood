import { InputError, record } from './validation.js'
import type { RateRule, RulesSnapshot, RulesUpdate } from '../shared/types.js'

export const DEFAULT_RULES = {
  emotion: { perEvent: 15, windowMs: 3_600_000, perWindow: 40 },
  personality: { perEvent: 0.05, windowMs: 86_400_000, perWindow: 3 },
} as const

export class RulesConflict extends Error {
  override name = 'RulesConflict'
  constructor() { super('变化规则已被其他页面修改，草稿已保留；请重新载入后修改。') }
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new InputError('变化规则包含未知字段')
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new InputError('无效的规则版本')
  return value as number
}
export function parseRateRule(input: unknown): RateRule {
  const value = record(input, '变化规则')
  fields(value, ['perEvent', 'windowMs', 'perWindow'])
  for (const key of ['perEvent', 'perWindow']) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) throw new InputError('变化额度必须是非负有限数')
  if (!Number.isSafeInteger(value.windowMs) || (value.windowMs as number) <= 0) throw new InputError('滚动时间必须是正的安全整数毫秒')
  return { perEvent: value.perEvent as number, windowMs: value.windowMs as number, perWindow: value.perWindow as number }
}
export function parseRules(input: unknown): RulesSnapshot {
  const value = record(input, '变化规则')
  fields(value, ['revision', 'emotion', 'personality'])
  return { revision: revision(value.revision), emotion: parseRateRule(value.emotion), personality: parseRateRule(value.personality) }
}
export function parseRulesUpdate(input: unknown): RulesUpdate {
  const value = record(input, '变化规则')
  fields(value, ['expectedRevision', 'emotion', 'personality'])
  return { expectedRevision: revision(value.expectedRevision), emotion: parseRateRule(value.emotion), personality: parseRateRule(value.personality) }
}
export function windowLabel(ms: number): string {
  for (const [unit, duration] of [['天', 86_400_000], ['小时', 3_600_000], ['分钟', 60_000], ['秒', 1000]] as const) if (ms % duration === 0) return `${ms / duration}${unit}`
  return `${ms}毫秒`
}
