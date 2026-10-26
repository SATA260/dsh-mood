import type { StateSnapshot } from '../shared/types.js'

/** A delayed response with the same version must not rewind natural recovery. */
export function shouldAdopt(previous: StateSnapshot | undefined, next: StateSnapshot): boolean {
  return !previous || next.version > previous.version || (next.version === previous.version && next.at >= previous.at)
}

export function formatValue(value: number, fractionDigits = 1): string {
  const rounded = Number(value.toFixed(fractionDigits))
  if (value !== 0 && rounded === 0) return '≈0'
  return rounded.toLocaleString('zh-CN', { maximumFractionDigits: fractionDigits })
}
