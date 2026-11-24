import { describe, expect, it } from 'vitest'
import { describeCleared, groupBySender, type ScanMessage } from './cleanup'

const scan = (id: string): ScanMessage => ({ id, from: { name: 'Daily News', address: 'news@daily.example.com' }, subject: 'today', preview: '', receivedAt: `2026-11-0${id}T10:00:00Z`, isRead: false, flagged: false })
const group = groupBySender([scan('1'), scan('2'), scan('3')])[0]

describe('a cleared sender', () => {
  it('says what happened to the mail and that a rule was made', () => {
    expect(describeCleared({ ...group, cleared: 'archive', ruled: true })).toBe('archived 3 · rule added')
    expect(describeCleared({ ...group, cleared: 'delete', ruled: true })).toBe('deleted 3 · rule added')
  })

  it('does not claim a rule when none was made', () => {
    expect(describeCleared({ ...group, cleared: 'archive' })).toBe('archived 3')
  })
})
