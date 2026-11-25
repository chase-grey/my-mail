/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { expect, it } from 'vitest'

// Lists load their next page on their own: see "loading more" in AGENTS.md.
const src = join(process.cwd(), 'src')
const screens = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
  .map((file) => ({ file, code: readFileSync(join(src, file), 'utf8') }))

it('has no button that loads the next page', () => {
  expect(screens.length).toBeGreaterThan(5)
  expect(screens.filter(({ code }) => />\s*(load|show|see) more\s*</i.test(code)).map(({ file }) => file)).toEqual([])
})

it('pages every list of mail from the end of the list', () => {
  const paged = screens.filter(({ code }) => /<NearEnd\b/.test(code)).map(({ file }) => file.split(sep).join('/')).sort()
  expect(paged).toEqual(['views/FoldersView.tsx', 'views/InboxView.tsx', 'views/ReceiptsView.tsx', 'views/SearchView.tsx'])
})
