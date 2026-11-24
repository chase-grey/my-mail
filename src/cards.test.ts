/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Desktop is cards: see "desktop" in AGENTS.md.
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8')
const wide = css.slice(css.indexOf('@media (min-width: 60rem)'), css.indexOf('@media (min-width: 100rem)'))
const rule = (selector: string) => wide.split('\n').find((line) => line.trim().startsWith(`${selector} {`)) ?? ''

it('gives each conversation its own card on a wide screen', () => {
  expect(rule('.list .items')).toMatch(/border: 0;.*background: none/)
  expect(rule('.list .item-clip')).toMatch(/border: 1px solid var\(--border\); border-radius: var\(--radius\); background: var\(--surface\)/)
})

it('fills and lifts the card whose message is open', () => {
  expect(rule('.main:has(.reader) .item.is-open .mail')).toContain('background: var(--accent)')
  expect(rule('.main:has(.reader) .item.is-open .item-clip')).toMatch(/border-color: var\(--accent\); box-shadow/)
})

it('shows the open message as a card, not a pane flush to the edges', () => {
  expect(rule('.reader')).toMatch(/max-width: .*margin: .*border: 1px solid var\(--border\); border-radius/)
  expect(rule('.reader')).not.toContain('border-left')
})
