import { expect, it } from 'vitest'
import { entryScript, isNewBuild } from './appUpdate'

const page = (name: string) => `<head><link rel="icon" href="/my-mail/icons/app-icon.svg" /><script type="module" crossorigin src="/my-mail/assets/${name}.js"></script><link rel="stylesheet" href="/my-mail/assets/index-a.css"></head>`

it('reads the entry script out of the published page', () => {
  expect(entryScript(page('index-abc123'))).toBe('/my-mail/assets/index-abc123.js')
  expect(entryScript('<html></html>')).toBeUndefined()
})

it('reloads only when the published page names another build', () => {
  expect(isNewBuild(page('index-new'), '/my-mail/assets/index-old.js')).toBe(true)
  expect(isNewBuild(page('index-old'), '/my-mail/assets/index-old.js')).toBe(false)
  // A page that could not be read, or a dev server with no built script, never triggers a reload.
  expect(isNewBuild('<html></html>', '/my-mail/assets/index-old.js')).toBe(false)
  expect(isNewBuild(page('index-new'), undefined)).toBe(false)
})
