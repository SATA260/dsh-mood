import { useEffect, useRef, useState } from 'react'
import { EMOTION_DEFINITIONS, TRAIT_DEFINITIONS } from '../shared/types.js'
import type { Emotions, MoodApi, MutationResult, ParameterId, StateSnapshot, Traits } from '../shared/types.js'

export type EditorKind = 'emotions' | 'traits'
interface Props {
  kind: EditorKind
  state: StateSnapshot
  api: MoodApi
  onClose(): void
  onSaved(result: MutationResult): void
}
export function StateEditor({ kind, state, api, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [opening, setOpening] = useState(state)
  const [draft, setDraft] = useState<Partial<Record<ParameterId, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const emotion = kind === 'emotions'
  const title = emotion ? '编辑情绪' : '编辑性格'
  const definitions = emotion ? EMOTION_DEFINITIONS : TRAIT_DEFINITIONS
  const values: Partial<Record<ParameterId, number>> = emotion ? opening.emotions : opening.traits
  const dirty = Object.entries(draft).some(([id, text]) => text.trim() === '' || Number(text) !== values[id as ParameterId])
  useEffect(() => {
    const element = dialog.current!
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.showModal()
    element.querySelector<HTMLInputElement>('input[type="number"]')?.focus({ preventScroll: true })
    return () => { element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  async function save() {
    const patch: Partial<Record<ParameterId, number>> = {}
    for (const d of definitions) {
      if (!Object.hasOwn(draft, d.id)) continue
      const text = draft[d.id]!
      const value = Number(text)
      if (!text.trim() || !Number.isFinite(value) || value < d.min || value > d.max) { setError(`${d.name}请输入 ${d.min}～${d.max} 的数值。`); return }
      if (value !== values[d.id]) patch[d.id] = value
    }
    if (!Object.keys(patch).length) return
    setBusy(true); setError('')
    try {
      const result = emotion ? await api.setEmotions({ patch: patch as Partial<Emotions>, expectedVersion: opening.version }) : await api.setTraits({ patch: patch as Partial<Traits>, expectedVersion: opening.version })
      onSaved(result)
    } catch (e) { setError(`${e instanceof Error ? e.message : String(e)} 草稿已保留，重新载入会放弃本次修改。`) }
    finally { setBusy(false) }
  }
  return <dialog ref={dialog} className="mood-dialog" aria-labelledby={`mood-edit-${kind}`} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <header className="mood-dialog-head"><div><h2 id={`mood-edit-${kind}`}>{title}</h2><p className="mood-help">{emotion ? '直接设置当前情绪，之后继续自然回稳。' : '调整之后的反应倾向，当前情绪保持连续。'}</p></div><button type="button" aria-label="关闭编辑" onClick={onClose} disabled={busy}>×</button></header>
      {error && <div role="alert" className="mood-alert">{error}<button type="button" disabled={busy} onClick={async () => {
        setBusy(true)
        try { setOpening(await api.getState()); setDraft({}); setError('') }
        catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        finally { setBusy(false) }
      }}>重新载入</button></div>}
      <div className="mood-editor-fields">{definitions.map(d => {
        const value = draft[d.id] ?? String(Number((values[d.id] ?? 0).toFixed(2)))
        return <div className="mood-edit-field" key={d.id}>
          <div className="mood-row"><label htmlFor={`mood-value-${d.id}`}>{d.name}</label><input id={`mood-value-${d.id}`} aria-label={`${d.name}数值`} title={`打开时的精确值 ${values[d.id]}`} type="number" min={d.min} max={d.max} step="any" required value={value} disabled={busy} onChange={event => setDraft(p => ({ ...p, [d.id]: event.target.value }))} /></div>
          <input aria-label={d.name} type="range" min={d.min} max={d.max} step={1} value={value.trim() && Number.isFinite(Number(value)) ? Number(value) : values[d.id] ?? 0} disabled={busy} onChange={event => setDraft(p => ({ ...p, [d.id]: event.target.value }))} />
          <div className="mood-endpoints"><span>{d.min} · {d.negative ?? d.zero}</span><span>{d.max} · {d.positive}</span></div>
        </div>
      })}</div>
      <footer className="mood-save"><span>{dirty ? '有未保存的修改' : '尚未修改'}</span><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="mood-primary" type="submit" disabled={!dirty || busy}>{busy ? '保存中…' : emotion ? '保存情绪' : '保存性格'}</button></footer>
    </form>
  </dialog>
}
