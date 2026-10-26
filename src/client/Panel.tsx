import { useCallback, useEffect, useRef, useState } from 'react'
import { EMOTION_DEFINITIONS, TRAIT_DEFINITIONS } from '../shared/types.js'
import type { HistoryPage, MoodApi, PromptSnapshot, StateSnapshot, Traits } from '../shared/types.js'
import { formatValue, shouldAdopt } from './state-view.js'

export interface PanelApi extends MoodApi { watchState?(): AsyncIterable<StateSnapshot> & { dispose(): void } }
export interface PanelProps { api: PanelApi; sessions?: readonly string[]; onBack?: () => void }
const number = formatValue
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function MoodPanel({ api, sessions = [], onBack }: PanelProps) {
  const [state, setState] = useState<StateSnapshot>()
  const [history, setHistory] = useState<HistoryPage>({ items: [] })
  const [snapshot, setSnapshot] = useState<PromptSnapshot | null>(null)
  const [selected, setSelected] = useState('')
  const sessionId = selected || sessions[0] || ''
  const [patch, setPatch] = useState<Partial<Traits>>({})
  const baseVersion = useRef<number>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const live = useRef(true)
  const readId = useRef(0)
  const adopt = useCallback((next: StateSnapshot) => {
    if (live.current) setState(previous => shouldAdopt(previous, next) ? next : previous)
  }, [])
  const refresh = useCallback(async () => {
    const requestId = ++readId.current
    try {
      const [current, changes, opening] = await Promise.all([api.getState(), api.listChanges({ limit: 20 }), sessionId ? api.getPromptSnapshot({ sessionId }) : Promise.resolve(null)])
      if (!live.current || requestId !== readId.current) return
      adopt(current); setHistory(changes); setSnapshot(opening)
    } catch (e) { if (live.current) setError(message(e)) }
  }, [api, sessionId, adopt])
  useEffect(() => {
    live.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    const focus = () => void refresh()
    window.addEventListener('focus', focus)
    const stream = api.watchState?.()
    if (stream) void (async () => {
      try { for await (const current of stream) { if (!live.current) break; adopt(current); void refresh() } }
      catch (e) { if (live.current) setError(`实时连接中断：${message(e)}。仍可手动刷新。`) }
    })()
    return () => { live.current = false; ++readId.current; clearInterval(timer); stream?.dispose(); window.removeEventListener('focus', focus) }
  }, [api, refresh, adopt])
  async function action(run: () => Promise<{ state: StateSnapshot; reason: string }>, saved = false) {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await run()
      if (!live.current) return
      adopt(result.state); setNotice(result.reason)
      if (saved) { setPatch({}); baseVersion.current = undefined }
      await refresh()
    } catch (e) { if (live.current) setError(`${message(e)}。若状态版本已变化，请放弃草稿后重新修改。`) }
    finally { if (live.current) setBusy(false) }
  }
  const dirty = Object.keys(patch).length > 0
  return <div className="mood-panel">
    <header className="mood-header"><div><div className="mood-eyebrow">DSH MOOD · 同一 PROFILE 共享</div><h1>搭档状态<span className="mood-dot" /></h1><p>此刻的感受，和慢慢形成的性格。</p></div><div className="mood-actions">{onBack && <button onClick={onBack}>返回对话</button>}<button onClick={() => { setError(''); void refresh() }}>刷新</button></div></header>
    {error && <div role="alert" className="mood-alert">{error}</div>}
    {notice && <div role="status" className="mood-notice">{notice}</div>}
    {!state ? <div className="mood-empty">{error ? '暂时无法读取搭档状态，原有数据未被重置。' : '正在读取搭档状态…'}</div> : <>
      <div className="mood-grid">
        <section className="mood-card"><div className="mood-section-head"><h2>现在的情绪</h2><span>v{state.version}</span></div><p className="mood-help">事件带来变化，随后逐渐回到基线。</p>
          <div className="mood-emotions">{EMOTION_DEFINITIONS.map(d => {
            const id = d.id as keyof typeof state.emotions
            const value = state.emotions[id]
            const position = (value - d.min) / (d.max - d.min) * 100
            const zero = (0 - d.min) / (d.max - d.min) * 100
            return <div className="mood-emotion" key={id}><div className="mood-row"><strong>{d.name}</strong><output aria-label={`${d.name}值`} title={`精确值 ${value}`}>{number(value)}<small> / {d.max}</small></output></div><div className="mood-rail" role="meter" aria-label={d.name} aria-valuemin={d.min} aria-valuemax={d.max} aria-valuenow={value}><span className="mood-range" style={{ left: `${Math.min(zero, position)}%`, width: `${Math.abs(position - zero)}%` }} /><span className="mood-baseline" title={`基线 ${number(state.baseline[id])}`} style={{ left: `${(state.baseline[id] - d.min) / (d.max - d.min) * 100}%` }} /><span className="mood-thumb" style={{ left: `${position}%` }} /></div><div className="mood-endpoints"><span>{d.negative ?? d.zero}</span><span>{d.positive}</span></div></div>
          })}</div><p className="mood-footnote">细线表示基线 · 显示一位小数，≈0 表示微小非零值；悬停查看精确值</p>
        </section>
        <section className="mood-card"><div className="mood-section-head"><h2>性格倾向</h2><span>−100 → +100</span></div><p className="mood-help">只有保存时才生效；情绪会连续地适应新性格。</p>
          {TRAIT_DEFINITIONS.map(d => { const id = d.id as keyof Traits; const value = patch[id] ?? state.traits[id]; return <label className="mood-trait" key={id}><div className="mood-row"><strong>{d.name}</strong><output title={`精确值 ${value}`}>{number(value)}</output></div><input aria-label={d.name} type="range" min={-100} max={100} step={1} value={value} disabled={busy} onChange={event => { if (baseVersion.current === undefined) baseVersion.current = state.version; setPatch(p => ({ ...p, [id]: Number(event.target.value) })) }} /><span className="mood-endpoints"><span>{d.negative}</span><span>{d.positive}</span></span></label> })}
          <div className="mood-save"><span>{dirty ? `已修改 ${Object.keys(patch).length} 项` : '尚未修改'}</span><button disabled={!dirty || busy} onClick={() => { setPatch({}); baseVersion.current = undefined; setError('') }}>放弃草稿</button><button className="mood-primary" disabled={!dirty || busy} onClick={() => void action(() => api.setTraits({ patch, expectedVersion: baseVersion.current! }), true)}>{busy ? '处理中…' : '保存性格'}</button></div>
        </section>
      </div>
      <section className="mood-card mood-snapshot"><div className="mood-section-head"><h2>开场快照</h2><label>会话 <select aria-label="快照会话" value={sessionId} onChange={e => setSelected(e.target.value)}><option value="">选择会话</option>{sessions.map(id => <option value={id} key={id}>{id}</option>)}</select></label></div>{snapshot ? <><p className="mood-help">第 {snapshot.turn} 轮 · 开场 v{snapshot.state.version} · 当前共享 v{state.version}。本轮工具续步沿用开场提示词。</p><details><summary>查看本轮注入内容</summary><pre>{snapshot.text}</pre></details></> : <p className="mood-help">{sessionId ? '这个会话尚无开场快照；发起新一轮消息后会记录。' : '选择一个会话，查看它最近一轮实际使用的提示词。'}</p>}</section>
      <section className="mood-card mood-history"><div className="mood-section-head"><h2>最近变化</h2><span>依据与实际结果</span></div>{!history.items.length && <p className="mood-empty">还没有变化记录。一次普通回复或一张表情，不会自行改动数值。</p>}{history.items.map(item => <article className={`mood-history-item ${item.valid ? '' : 'mood-revoked'}`} key={item.id}><div className="mood-history-main"><div className="mood-row"><strong>{{ emotion: '情绪事件', personality: '性格慢变', manual: '手动编辑', configuration: '参数调整' }[item.kind]}<span className="mood-tag">{!item.valid ? '已撤销' : item.needsReview ? '依据待复核' : `#${item.id}`}</span></strong><time>{new Date(item.at).toLocaleString('zh-CN', { hour12: false })}</time></div><p>{item.reason}</p><div className="mood-changes">{Object.entries(item.actualChanges).map(([key, value]) => <span key={key} title={`实际变化 ${value}`}>{[...EMOTION_DEFINITIONS, ...TRAIT_DEFINITIONS].find(d => d.id === key)?.name ?? key} {value! > 0 ? '+' : ''}{formatValue(value!, 2)}</span>)}</div>{item.effectSummary && <p className="mood-help">{item.effectSummary}</p>}{!item.effectSummary && item.limited.length > 0 && <p className="mood-limit">{item.limited.map(id => `${[...EMOTION_DEFINITIONS, ...TRAIT_DEFINITIONS].find(d => d.id === id)?.name ?? id}：受单次额度、滚动额度或量程边界限制`).join('；')}</p>}<details><summary>查看依据</summary><p className="mood-evidence">{item.evidenceIds.length ? item.evidenceIds.join('\n') : '用户设置／配置变更'}</p></details></div>{item.kind === 'emotion' && item.valid && <button disabled={busy} onClick={() => void action(() => api.invalidateEvent({ eventId: item.id, expectedVersion: state.version }))}>这次理解错了</button>}</article>)}{history.nextCursor && <button disabled={busy} onClick={async () => { try { const next = await api.listChanges({ cursor: history.nextCursor, limit: 20 }); setHistory(h => ({ items: [...h.items, ...next.items], nextCursor: next.nextCursor })) } catch (e) { setError(message(e)) } }}>更早的记录</button>}</section>
    </>}
  </div>
}
