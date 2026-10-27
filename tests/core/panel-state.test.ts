import { expect, it } from 'vitest'
import { formatValue, shouldAdopt } from '../../src/client/state-view.js'
import { radarRatio } from '../../src/client/RadarChart.js'
import type { StateSnapshot } from '../../src/shared/types.js'

it('shows small real changes and never rounds them to a misleading zero or negative zero', () => {
  expect(formatValue(0.24)).toBe('0.2')
  expect(formatValue(-0.24)).toBe('-0.2')
  expect(formatValue(0)).toBe('0')
  expect(formatValue(-0)).toBe('0')
  expect(formatValue(-0.004)).toBe('≈0')
  expect(formatValue(0.004)).toBe('≈0')
  expect(formatValue(0.25, 2)).toBe('0.25')
})
it('radar mapping retains signed ranges and distinguishes bipolar zero from unipolar zero', () => {
  expect(radarRatio(-100, -100, 100)).toBe(0)
  expect(radarRatio(0, -100, 100)).toBe(0.5)
  expect(radarRatio(100, -100, 100)).toBe(1)
  expect(radarRatio(-40.5, -100, 100)).toBeCloseTo(0.2975)
  expect(radarRatio(0, 0, 100)).toBe(0)
})
it('never rewinds recovery or committed changes when streamed and polled responses arrive out of order', () => {
  const state = (version: number, at: number) => ({ version, at }) as StateSnapshot
  expect(shouldAdopt(undefined, state(1, 100))).toBe(true)
  expect(shouldAdopt(state(2, 200), state(2, 100))).toBe(false)
  expect(shouldAdopt(state(2, 200), state(1, 300))).toBe(false)
  expect(shouldAdopt(state(2, 200), state(2, 300))).toBe(true)
  expect(shouldAdopt(state(2, 200), state(3, 100))).toBe(true)
})
