import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CleanupView, type CleanupActions, type CleanupState } from './CleanupView'

const nothing = async () => {}
const actions: CleanupActions = { scan: nothing, archiveSender: nothing, deleteSender: nothing, blockSender: nothing, undoSender: nothing, unsubscribe: async () => '', archiveOld: nothing, undoOld: nothing }
const state = (over: Partial<CleanupState>): CleanupState => ({ scanned: 0, groups: [], old: { count: 0, unread: 0, flagged: 0 }, done: true, ...over })
const render = (over: Partial<CleanupState>) => renderToStaticMarkup(<CleanupView state={state(over)} actions={actions} onError={() => {}} />)

it('offers all old mail in one press, unread included', () => {
  const html = render({ old: { count: 4212, unread: 3900, flagged: 3 } })
  expect(html).toContain('old mail')
  expect(html).toContain(`${(4212).toLocaleString()} older than 30 days · ${(3900).toLocaleString()} unread · 3 flagged stay`)
  expect(html).toContain('archive all')
  expect(html).not.toContain('undo')
})

it('keeps an undo once the old mail is gone, and shows nothing when there was none', () => {
  const swept = render({ swept: 4212 })
  expect(swept).toContain(`archived ${(4212).toLocaleString()}`)
  expect(swept).toContain('undo')
  expect(swept).not.toContain('older than 30 days')
  expect(render({})).not.toContain('old mail')
})
