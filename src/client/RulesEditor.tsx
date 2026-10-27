import { useEffect, useState } from 'react'
import { DEFAULT_RULES, parseRulesUpdate } from '../core/rules.js'
import type { MoodApi, RateRule, RulesSnapshot } from '../shared/types.js'

const UNITS = [{ name: '天', ms: 86_400_000 }, { name: '小时', ms: 3_600_000 }, { name: '分钟', ms: 60_000 }, { name: '秒', ms: 1000 }]
type Group = 'emotion' | 'personality'
interface Draft { perEvent: string; duration: string; unit: string; perWindow: string }
type Drafts = Record<Group, Draft>
function draft(rule: RateRule): Draft {
  const unit = UNITS.find(u => rule.windowMs % u.ms === 0) ?? UNITS[3]!
  return { perEvent: String(rule.perEvent), duration: String(rule.windowMs / unit.ms), unit: String(unit.ms), perWindow: String(rule.perWindow) }
}
function drafts(rules: Pick<RulesSnapshot, Group>): Drafts { return { emotion: draft(rules.emotion), personality: draft(rules.personality) } }
function read(value: Draft): RateRule {
  if ([value.perEvent, value.duration, value.perWindow].some(s => !s.trim())) throw new Error('请填写完整的变化规则。')
  const duration = Number(value.duration) * Number(value.unit)
  if (!Number.isFinite(duration) || Math.abs(duration - Math.round(duration)) > 1e-6) throw new Error('时间必须能换算为整数毫秒。')
  return { perEvent: Number(value.perEvent), windowMs: Math.round(duration), perWindow: Number(value.perWindow) }
}
interface Props { rules: RulesSnapshot; api: MoodApi; onSaved(rules: RulesSnapshot): void }
export function RulesEditor({ rules, api, onSaved }: Props) {
  const [opening, setOpening] = useState(rules)
  const [values, setValues] = useState(() => drafts(rules))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const dirty = JSON.stringify(values) !== JSON.stringify(drafts(opening))
  useEffect(() => {
    if (!dirty && rules.revision > opening.revision) { setOpening(rules); setValues(drafts(rules)) }
  }, [rules, dirty, opening.revision])
  async function reload() {
    setBusy(true)
    try { const next = await api.getRules(); setOpening(next); setValues(drafts(next)); setError(''); setNotice('已载入当前规则。') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function save() {
    setError(''); setNotice('')
    try {
      const request = parseRulesUpdate({ expectedRevision: opening.revision, emotion: read(values.emotion), personality: read(values.personality) })
      setBusy(true)
      const next = await api.setRules(request)
      setOpening(next); setValues(drafts(next)); setNotice('变化规则已保存，后续自动更新立即生效。'); onSaved(next)
    } catch (e) { setError(`${e instanceof Error ? e.message : String(e)} 草稿已保留。`) }
    finally { setBusy(false) }
  }
  function change(group: Group, key: keyof Draft, value: string) { setValues(previous => ({ ...previous, [group]: { ...previous[group], [key]: value } })) }
  return <section className="mood-card mood-rules" aria-labelledby="mood-rules-title">
    <div className="mood-section-head"><h2 id="mood-rules-title">变化规则</h2><span>规则 v{opening.revision}</span></div>
    <p className="mood-help">每项属性独立计额，增加和减少都按绝对值累计。自然回稳、手动编辑不占额度；额度为 0 时暂停对应自动更新。</p>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="mood-rules-grid">{(['emotion', 'personality'] as const).map(group => {
        const name = group === 'emotion' ? '情绪' : '性格'
        const value = values[group]
        return <fieldset key={group} disabled={busy}><legend>{name}</legend>
          <label>单事件最大变化（点）<input aria-label={`${name}单事件上限`} type="number" min="0" step="any" required value={value.perEvent} onChange={e => change(group, 'perEvent', e.target.value)} /></label>
          <div className="mood-rules-time"><label>滚动时间窗口<input aria-label={`${name}时间长度`} type="number" min="0.000001" step="any" required value={value.duration} onChange={e => change(group, 'duration', e.target.value)} /></label><label>单位<select aria-label={`${name}时间单位`} value={value.unit} onChange={e => change(group, 'unit', e.target.value)}>{UNITS.map(unit => <option value={unit.ms} key={unit.ms}>{unit.name}</option>)}</select></label></div>
          <label>窗口内每项累计上限（点）<input aria-label={`${name}累计上限`} type="number" min="0" step="any" required value={value.perWindow} onChange={e => change(group, 'perWindow', e.target.value)} /></label>
          {group === 'personality' && <p className="mood-help">一个真实事件即可微量成长。轻微／明显／强烈按单事件上限的 20%／50%／100% 换算。</p>}
        </fieldset>
      })}</div>
      {error && <div role="alert" className="mood-alert">{error}<button type="button" disabled={busy} onClick={() => void reload()}>重新载入规则</button></div>}
      {notice && <p role="status" className="mood-rules-notice">{notice}</p>}
      <div className="mood-save"><span>{dirty ? '有未保存的规则修改' : '修改后保存才生效'}</span><button type="button" disabled={busy} onClick={() => { setValues(drafts(DEFAULT_RULES)); setError(''); setNotice('默认值已填入，保存后才生效。') }}>恢复默认规则</button><button type="button" disabled={busy || (!dirty && !error)} onClick={() => void reload()}>取消规则修改</button><button className="mood-primary" type="submit" disabled={busy || !dirty}>{busy ? '保存中…' : '保存变化规则'}</button></div>
    </form>
  </section>
}
