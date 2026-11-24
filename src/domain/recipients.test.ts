import { describe, expect, it } from 'vitest'
import { fileSize, formatRecipients, parseRecipients, withNames } from './recipients'

describe('parseRecipients', () => {
  it('splits on commas, semicolons, and new lines, and keeps a name written beside an address', () => {
    expect(parseRecipients('Mom@Example.com; "Owen Marsh" <owen@example.com>\n tess@example.com,')).toEqual({
      recipients: [{ address: 'mom@example.com' }, { name: 'Owen Marsh', address: 'owen@example.com' }, { address: 'tess@example.com' }],
      invalid: [],
    })
  })

  it('names what is not an address and drops a repeat', () => {
    expect(parseRecipients('mom@example.com, mom, MOM@example.com, a@b')).toEqual({ recipients: [{ address: 'mom@example.com' }], invalid: ['mom', 'a@b'] })
  })
})

it('shows addresses alone and puts known names back', () => {
  const known = [{ name: 'Mom', address: 'Mom@example.com' }, { name: 'x@example.com', address: 'x@example.com' }]
  expect(formatRecipients([{ name: 'Mom', address: 'mom@example.com' }, { address: 'x@example.com' }])).toBe('mom@example.com, x@example.com')
  expect(withNames([{ address: 'mom@example.com' }, { address: 'x@example.com' }, { name: 'Dad', address: 'dad@example.com' }], known)).toEqual([{ name: 'Mom', address: 'mom@example.com' }, { address: 'x@example.com' }, { name: 'Dad', address: 'dad@example.com' }])
})

it('writes file sizes the short way', () => {
  expect([fileSize(10), fileSize(240 * 1024), fileSize(1.25 * 1024 * 1024)]).toEqual(['1 kb', '240 kb', '1.3 mb'])
})
