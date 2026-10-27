import { formatValue } from './state-view.js'
import type { ParameterDefinition } from '../shared/types.js'

export const radarRatio = (value: number, min: number, max: number): number => Math.max(0, Math.min(1, (value - min) / (max - min)))
const point = (index: number, count: number, radius: number) => {
  const angle = index * Math.PI * 2 / count - Math.PI / 2
  return { x: 220 + Math.cos(angle) * radius, y: 183 + Math.sin(angle) * radius }
}
const polygon = (radii: number[]) => radii.map((radius, index) => { const p = point(index, radii.length, radius); return `${p.x},${p.y}` }).join(' ')

interface Props {
  title: string
  definitions: readonly ParameterDefinition[]
  values: Partial<Record<ParameterDefinition['id'], number>>
  reference?: Partial<Record<ParameterDefinition['id'], number>>
  tone: 'emotion' | 'personality'
}
export function RadarChart({ title, definitions, values, reference, tone }: Props) {
  const digits = tone === 'personality' ? 3 : 1
  const radii = definitions.map(d => radarRatio(values[d.id] ?? 0, d.min, d.max) * 119)
  const neutral = definitions.map(d => radarRatio(0, d.min, d.max) * 119)
  return <figure className={`mood-radar mood-radar-${tone}`}>
    <svg viewBox="0 0 440 366" role="img" aria-label={title}>
      <title>{title}</title>
      <desc>圆心为各项下限，外圈为上限。圆点标记零位；标签保留原始正负数值。</desc>
      {[.25, .5, .75, 1].map(level => <polygon key={level} className="mood-radar-grid" points={polygon(definitions.map(() => 119 * level))} />)}
      {definitions.map((d, index) => { const end = point(index, definitions.length, 119); return <line className="mood-radar-axis" key={d.id} x1={220} y1={183} x2={end.x} y2={end.y} /> })}
      <polygon className="mood-radar-area" points={polygon(radii)} />
      <polygon className="mood-radar-reference" points={polygon(reference ? definitions.map(d => radarRatio(reference[d.id] ?? 0, d.min, d.max) * 119) : neutral)} />
      {definitions.map((d, index) => {
        const p = point(index, definitions.length, radii[index]!)
        const zero = point(index, definitions.length, neutral[index]!)
        const label = point(index, definitions.length, 153)
        const value = values[d.id] ?? 0
        const display = `${value > 0 ? '+' : ''}${formatValue(value, digits)}`
        return <g key={d.id} data-axis={d.id}>
          <circle className="mood-radar-zero" cx={zero.x} cy={zero.y} r={3}><title>{d.name}：零位</title></circle>
          <circle className="mood-radar-value" cx={p.x} cy={p.y} r={4} data-ratio={radarRatio(value, d.min, d.max)}><title>{d.name}：{value}（{d.min}～{d.max}）</title></circle>
          <text x={label.x} y={label.y - 5} textAnchor="middle" className="mood-radar-label">{d.name}</text>
          <text x={label.x} y={label.y + 14} textAnchor="middle" className="mood-radar-number">{display}</text>
        </g>
      })}
    </svg>
    <div className="mood-sr-only">{definitions.map(d => <div key={d.id}>
      <div role="meter" aria-label={d.name} aria-valuemin={d.min} aria-valuemax={d.max} aria-valuenow={values[d.id] ?? 0} />
      <output aria-label={`${d.name}值`}>{formatValue(values[d.id] ?? 0, digits)}</output>
    </div>)}</div>
    <figcaption>{tone === 'emotion' ? '悲喜、好恶 −100～+100；其余 0～100。虚线为基线，空心点为零位。' : '圆心 −100 · 虚线 0 · 外圈 +100。负值与正值分别代表两端倾向。'}</figcaption>
  </figure>
}
