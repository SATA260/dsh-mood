import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, jsonSchemaToTs, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as MoodPlugin from '../../src/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })
async function host() {
  const dir = mkdtempSync(join(tmpdir(), 'mood-host-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  const plugin = ctx.plugin(MoodPlugin, { dataDir: dir })
  await plugin.await()
  disposals.push(async () => { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) })
  return { ctx, plugin }
}
function agent(ctx: Context, id: string): Agent { return { id: SessionId(id), session: Session.create(SessionId(id)), ctx } as Agent }
async function pre(ctx: Context, a: Agent, turn: number, step: number, userId?: string) {
  const messages = userId ? [{ id: MessageId(userId), role: 'user' as const, source: { kind: 'user' as const }, content: [{ type: 'text' as const, text: `实际消息 ${userId}` }] }] : []
  return ctx.waterfall('agent/pre-step', { agent: a, turn, step, messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
}
describe('DSH 0.2.1-rc.2 real Cordis / SystemPrompt / ToolRuntime integration, without keys', () => {
  it('does not record a proposed step rejected by another Host policy', async () => {
    const { ctx } = await host()
    const a = agent(ctx, 'rejected-chat')
    ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
    expect(await pre(ctx, a, 1, 1, 'not-admitted')).toEqual({ kind: 'reject' })
    expect(ctx.mood.getPromptSnapshot({ sessionId: a.id })).toBeNull()
    expect(ctx.mood.getState().version).toBe(0)
  })
  it('retains host sections, freezes step continuations and disposes only plugin registrations', async () => {
    const { ctx, plugin } = await host()
    ctx.systemPrompt.section({ name: 'host-original', order: 0, text: '宿主原有规则' })
    const a = agent(ctx, 'chat-a')
    await pre(ctx, a, 1, 1, 'u1')
    const first = renderPrompt(await ctx.systemPrompt.assemble({ scope: a }))
    expect(first).toContain('宿主原有规则')
    expect(first).toContain('social_pref 社交取向: 0%')
    ctx.mood.setTraits({ patch: { social_pref: 80 }, expectedVersion: 0 })
    await pre(ctx, a, 1, 2)
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: a }))).toBe(first)
    await pre(ctx, a, 2, 1, 'u2')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: a }))).toContain('80%')
    const b = agent(ctx, 'chat-b')
    await pre(ctx, b, 1, 1, 'b1')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: b }))).toContain('80%')
    await plugin.dispose()
    expect(ctx.tools.get('mood_update_emotion')).toBeUndefined()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: a }))).toBe('宿主原有规则')
  })
  it('executes model tools through SDK validation, returns actual state and blocks direct numbers', async () => {
    const { ctx } = await host()
    const a = agent(ctx, 'chat-a')
    await pre(ctx, a, 1, 1, 'u1')
    const call = (id: string, args: unknown) => ctx.tools.execute({ agent: a, callId: ToolCallId(id), name: 'mood_update_emotion', arguments: args, signal: new AbortController().signal })
    const args = { event_id: 'current_user_message', features: [{ feature_id: 'outcome', direction: 'positive', intensity: 'moderate', reason: '目标已完成', evidence: ['current_user_message'] }] }
    const result = await call('call-1', args)
    expect(result.isError).toBeFalsy()
    expect(ctx.mood.getState().emotions.valence).toBeGreaterThan(4.99)
    expect((await call('call-1', args)).isError).toBeFalsy()
    expect(ctx.mood.getState().version).toBe(1)
    expect((await call('bad', { ...args, features: [{ ...args.features[0], intensity: .9 }] })).isError).toBe(true)
    expect(ctx.mood.getState().version).toBe(1)
    ctx.tools.register(defineTool({
      name: 'fixture_wrapper', description: 'keyless transport fixture', parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(_args, exec) {
        const failed = await ctx.tools.execute({ agent: a, name: 'mood_update_emotion', callId: ToolCallId('nested-invalid'), rootCallId: exec.rootCallId, parent: exec.token, signal: exec.signal, arguments: { ...args, features: [{ ...args.features[0], intensity: 1 }] } })
        return { isError: failed.isError === true }
      },
    }))
    await ctx.tools.execute({ agent: a, callId: ToolCallId('outer'), name: 'fixture_wrapper', arguments: {}, signal: new AbortController().signal })
    const event = a.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('outer'), name: 'fixture_wrapper', arguments: '{}' })
    ctx.emit('session/event', a.session, event)
    const settled = a.session.append('tool/result', { turn: 1, step: 1, message: { id: MessageId('outer-result'), role: 'tool', source: { kind: 'tool', callId: ToolCallId('outer') }, toolCallId: ToolCallId('outer'), content: [{ type: 'text', text: '{"isError":true}' }] } }, { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
    ctx.emit('session/event', a.session, settled)
    const selfReference = await call('try-own-error', { event_id: 'last_tool_result', features: [{ ...args.features[0], evidence: ['last_tool_result'] }] })
    expect(selfReference.value).toMatchObject({ status: 'rejected' })
    expect(ctx.mood.getState().version).toBe(1)
  })
  it('inspects bounded event summaries only on demand, without writes, and still requires evidence to update', async () => {
    const { ctx } = await host()
    const a = agent(ctx, 'chat-evidence')
    const call = (name: string, id: string, args: unknown) => ctx.tools.execute({ agent: a, callId: ToolCallId(id), name, arguments: args, signal: new AbortController().signal })
    await pre(ctx, a, 1, 1, 'raw-only')
    const inspect = () => call('mood_update_personality', 'inspect', { mode: 'inspect', attribute_id: 'explore_pref' })
    expect((await inspect()).value).toEqual({ status: 'inspection', candidates: [], minimumEvents: 3 })
    expect(ctx.mood.getState().version).toBe(0)
    for (let i = 1; i <= 8; i++) {
      await pre(ctx, a, i + 1, 1, `u${i}`)
      const result = await call('mood_update_emotion', `emotion-${i}`, { event_id: 'current_user_message', features: [{ feature_id: 'novelty', direction: 'positive', intensity: 'slight', reason: `探索事件${i} ${'摘'.repeat(200)}`, evidence: ['current_user_message'] }] })
      expect(result.isError).toBeFalsy()
      expect(result.value).toMatchObject({ state: { version: i, traits: {}, emotions: {} } })
      expect(JSON.stringify(result.value)).not.toContain('definitions')
    }
    const result = await inspect()
    const candidates = (result.value as { candidates: { id: string; summary: string }[] }).candidates
    expect(candidates).toHaveLength(6)
    expect(candidates.every(c => c.summary.length <= 120)).toBe(true)
    expect(JSON.stringify(candidates)).not.toMatch(/实际消息|raw-only/)
    expect(ctx.mood.getState().version).toBe(8)
    expect(ctx.mood.listChanges({ limit: 100 }).items).toHaveLength(8)
    const missing = await call('mood_update_personality', 'missing-fields', { attribute_id: 'explore_pref' })
    expect(missing.value).toMatchObject({ status: 'rejected' })
    const ids = candidates.slice(0, 3).map(c => c.id)
    const update = await call('mood_update_personality', 'trait-update', { attribute_id: 'explore_pref', direction: 'positive', intensity: 'slight', reason: '多次探索呈现稳定倾向', evidence: ids })
    expect(update.value).toMatchObject({ status: 'applied' })
    expect(ctx.mood.getState().version).toBe(9)
    const remaining = (await inspect()).value as { candidates: { id: string }[] }
    expect(remaining.candidates.every(c => !ids.includes(c.id))).toBe(true)
    const event = ctx.mood.listChanges({}).items.find(e => e.sourceId === remaining.candidates[0]!.id)!
    ctx.mood.invalidateEvent({ eventId: event.id, expectedVersion: 9 })
    const corrected = (await inspect()).value as { candidates: { id: string }[] }
    expect(corrected.candidates.some(c => c.id === event.sourceId)).toBe(false)
    expect((await call('mood_update_personality', 'inspect-write', { mode: 'inspect', attribute_id: 'explore_pref', direction: 'positive' })).isError).toBe(true)
  })
  it('rejects ambiguous conflict signs in the real SDK, raises anger for insults and lowers it for repair', async () => {
    const { ctx } = await host()
    const projected = jsonSchemaToTs(ctx.tools.schemas().find(s => s.name === 'mood_update_emotion')!.parameters)
    expect(projected).not.toBe('unknown')
    expect(projected).toContain('"present" | "relieved"')
    const a = agent(ctx, 'anger-regression')
    const call = (id: string, direction: string, reason: string) => ctx.tools.execute({ agent: a, callId: ToolCallId(id), name: 'mood_update_emotion', arguments: { event_id: 'current_user_message', features: [{ feature_id: 'conflict', direction, intensity: 'moderate', reason, evidence: ['current_user_message'] }] }, signal: new AbortController().signal })
    await pre(ctx, a, 1, 1, 'insult')
    expect((await call('bad-negative', 'negative', '被明确冒犯')).isError).toBe(true)
    expect((await call('bad-positive', 'positive', '被明确冒犯')).isError).toBe(true)
    expect(ctx.mood.getState().version).toBe(0)
    expect(ctx.mood.listChanges({}).items).toEqual([])
    expect((await call('insult-corrected', 'present', '被明确冒犯')).value).toMatchObject({ actualChanges: { anger: 5 } })
    await pre(ctx, a, 2, 1, 'repair')
    const repaired = await call('repair-correct', 'relieved', '对方收回冒犯，冲突明确缓解')
    expect(repaired.isError).toBeFalsy()
    const value = repaired.value as { actualChanges: { anger: number }; state: { emotions: { anger: number } } }
    expect(value.actualChanges.anger).toBeLessThan(0)
    expect(value.state.emotions.anger).toBe(0)
  })
})

describe('strict Remote contract on the real Host Gateway', () => {
  it('dispatches reads, rejects malformed writes, streams commits and withdraws definitions', async () => {
    const { createRequire } = await import('node:module')
    const rootRequire = createRequire(import.meta.url)
    const require = createRequire(rootRequire.resolve('@deepseek-ai/dsh-api-gateway'))
    const { TypertRegistry } = await import(require.resolve('@deepseek-ai/dsh-typert-registry'))
    const { TypertGatewayService } = await import('@deepseek-ai/dsh-api-gateway')
    const { TYPERT } = await import('../../src/typert.host.js')
    const { ctx, plugin } = await host()
    await ctx.plugin(TypertRegistry)
    ctx.reflect.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'test-restricted' }) })
    const remove = ctx.typert.register(TYPERT)
    await ctx.plugin(TypertGatewayService)
    const controller = new AbortController()
    const peer = { id: 'test-owner', ctx, principal: { kind: 'owner' as const }, signal: controller.signal, interactions: 'none' as const, dispose: async () => controller.abort() }
    const request = (method: string, args = {}) => ({ namespace: 'mood', method, args, peer, signal: controller.signal })
    expect(await ctx.typertGateway.invoke(request('getState'))).toMatchObject({ roleId: 'companion', version: 0 })
    await expect(ctx.typertGateway.invoke(request('setTraits', { request: { expectedVersion: 0, patch: { recovery: 999 } } }))).rejects.toThrow()
    expect(ctx.mood.getState().version).toBe(0)
    const stream = await ctx.typertGateway.stream(request('watchState'))
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ version: 0 })
    await ctx.typertGateway.invoke(request('setTraits', { request: { expectedVersion: 0, patch: { recovery: 80 } } }))
    expect((await iterator.next()).value).toMatchObject({ version: 1, traits: { recovery: 80 } })
    await expect(ctx.typertGateway.invoke(request('setTraits', { request: { expectedVersion: 0, patch: { recovery: 20 } } }))).rejects.toThrow('其他聊天')
    controller.abort()
    await iterator.return?.()
    remove()
    await plugin.dispose()
    await expect(ctx.typertGateway.invoke({ ...request('getState'), peer: { ...peer, signal: new AbortController().signal }, signal: new AbortController().signal })).rejects.toThrow()
  })
})
