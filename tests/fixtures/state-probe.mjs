import { writeFileSync } from 'node:fs'
export const inject = ['mood']
export function apply(ctx) {
  const opening = ctx.mood.getState()
  if (opening.version === 0) ctx.mood.setTraits({ patch: { social_pref: 35.25, recovery: 80.5 }, expectedVersion: 0 })
  writeFileSync(process.env.DSH_MOOD_SMOKE_RESULT, JSON.stringify(ctx.mood.getState()))
}
