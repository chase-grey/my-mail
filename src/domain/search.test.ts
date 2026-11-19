import { describe, expect, it } from 'vitest'
import { answerParts, rememberSearch, searchMode } from './search'

describe('search', () => {
  it('finds on operators and bare words, asks on questions and sentences', () => {
    expect(searchMode('invoice')).toBe('find')
    expect(searchMode('dentist appointment')).toBe('find')
    expect(searchMode('from:ruth subject:dinner')).toBe('find')
    expect(searchMode('received>=2026-01-01 tax')).toBe('find')
    expect(searchMode('"property tax" OR treasurer')).toBe('find')
    expect(searchMode('did the landlord confirm?')).toBe('ask')
    expect(searchMode('what was the electrician total')).toBe('ask')
    expect(searchMode('the invoice the electrician sent last spring')).toBe('ask')
    expect(searchMode('from:ruth did she say when?')).toBe('find')
  })

  it('keeps recent searches newest first without repeats', () => {
    expect(rememberSearch(['tax', 'dinner'], ' Dinner ')).toEqual(['Dinner', 'tax'])
    expect(rememberSearch(['a', 'b'], 'c', 2)).toEqual(['c', 'a'])
    expect(rememberSearch(['a'], '  ')).toEqual(['a'])
  })

  it('splits an answer at the message numbers it cites', () => {
    expect(answerParts('The total was $480 [2]. Paid in May [3][9].', 3)).toEqual(['The total was $480 ', 2, '. Paid in May ', 3, '[9].'])
    expect(answerParts('Nothing here.', 2)).toEqual(['Nothing here.'])
  })
})
