import { describe, expect, it } from 'vitest'
import { frameDocument, framePolicy, linkParts, wearsAppColours } from './mailHtml'

describe('mail markup for reading', () => {
  it('puts the policy ahead of anything the message brings and opens links in a new tab', () => {
    const page = frameDocument('<html><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0; url=https://evil.example/"></head><body><p>hi</p></body></html>')
    expect(page.indexOf(framePolicy)).toBeGreaterThan(0)
    expect(page.indexOf(framePolicy)).toBeLessThan(page.indexOf('<html>'))
    expect(page.indexOf('<base target="_blank">')).toBeLessThan(page.indexOf('evil.example'))
    expect(page).not.toMatch(/http-equiv="refresh"/i)
    expect(page).toContain('<p>hi</p>')
    expect(framePolicy).not.toMatch(/script|frame|connect/)
  })

  it('lets plain markup follow dark mode and lays designed mail on white', () => {
    expect(wearsAppColours('<p>Does <b>five</b> work?</p>')).toBe(true)
    expect(wearsAppColours('<div style="color:rgb(0,0,0)">hi</div>')).toBe(false)
    expect(wearsAppColours('<table bgcolor="#ffffff"><tr><td>sale</td></tr></table>')).toBe(false)
    expect(frameDocument('<p>hi</p>')).toContain('color-scheme: light dark')
    expect(frameDocument('<p style="background:#fff">hi</p>')).toContain('color-scheme: light;')
  })

  it('finds the links in bare text and leaves the full stop after one alone', () => {
    expect(linkParts('Pay at https://example.com/pay?x=1. Or by mail.')).toEqual(['Pay at ', { href: 'https://example.com/pay?x=1' }, '. Or by mail.'])
    expect(linkParts('no links')).toEqual(['no links'])
    expect(linkParts('https://a.example https://b.example')).toEqual([{ href: 'https://a.example' }, ' ', { href: 'https://b.example' }])
  })
})
