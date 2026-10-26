import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT_REMOTE } from '../remote.js'
import type { PanelApi } from './Panel.js'
import { MoodPanel } from './Panel.js'
import stylesheet from './style.css'
import { registerStickers } from './sticker-node.js'

export const inject = ['remote', 'slots', 'layout', 'uiConversation']
const PANEL_ID = 'dsh-mood' as MainPanelId
function unwrap<T>(result: RemoteResult<T>): T { if (!result.ok) throw result.error; return result.value }
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => { const style = document.createElement('style'); style.dataset.dshMood = ''; style.textContent = stylesheet; document.head.append(style); return () => style.remove() })
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => unmount)
  ctx.inject(['remote.mood', 'remote.moodStickers'], child => {
  const ctx = child
  const remote = ctx.remote.mood
  const api: PanelApi = {
    getState: async () => unwrap(await remote.getState()),
    listChanges: async request => unwrap(await remote.listChanges(request)),
    setTraits: async request => unwrap(await remote.setTraits(request)),
    invalidateEvent: async request => unwrap(await remote.invalidateEvent(request)),
    getPromptSnapshot: async request => unwrap(await remote.getPromptSnapshot(request)),
    watchState: () => remote.watchState(),
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, ({ useSessions }: { useSessions: UseSessions }) => {
    const ids = useSessions(state => state.ids)
    return <MoodPanel api={api} sessions={ids} onBack={() => ctx.layout.selectPanel(null)} />
  }))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: '搭档状态' }, ({ size }: { size: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20.5 11.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z"/><path d="M8 14c1.8 2 6.2 2 8 0M8 9h.01M16 9h.01" strokeLinecap="round" /></svg>))
  const imageCache = new Map<string, Promise<string | null>>()
  const loadSticker = (id: string): Promise<string | null> => {
    let pending = imageCache.get(id)
    if (!pending) {
      pending = ctx.remote.moodStickers.getImage({ id }).then(result => unwrap(result)?.dataUrl ?? null)
      imageCache.set(id, pending)
      void pending.catch(() => imageCache.delete(id))
    }
    return pending
  }
  registerStickers(ctx, location.protocol === 'dsh-app:' || 'dshDesktop' in globalThis ? loadSticker : undefined)
  })
}
