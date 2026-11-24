import { describe, expect, it } from 'vitest'
import { brightness, darkened, frameDocument, framePolicy, linkParts, mailLook, wearsAppColours } from './mailHtml'

const designed = '<html><body><table bgcolor="#ffffff"><tr><td style="color:#222222">sale</td></tr></table></body></html>'
const plain = '<p>Does <b>five</b> work?</p>'
const on = `<html class="${darkened}">`

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

  it('darkens every message in dark mode, with a way back to light for one', () => {
    expect(mailLook(true, false)).toEqual({ look: 'dark', toggle: 'light mode' })
    expect(mailLook(true, true)).toEqual({ look: 'light', toggle: 'dark mode' })
    // Designed mail is turned dark; mail with no colours of its own takes the app's dark ones.
    expect(frameDocument(designed, 'dark')).toContain(on)
    expect(frameDocument(designed, 'dark')).not.toContain('background: #fff')
    for (const html of [designed, plain]) expect(frameDocument(html, 'dark')).toContain('color-scheme: dark')
    expect(frameDocument(plain, 'dark')).toContain('color: #ececea')
    // Switched to light, either kind is on white as it was sent.
    for (const html of [designed, plain]) {
      const page = frameDocument(html, 'light')
      expect(page).not.toContain(on)
      expect(page).toContain('color-scheme: light')
      expect(page).toContain('html { background: #fff; }')
    }
  })

  it('offers nothing to switch in light mode and darkens nothing', () => {
    expect(mailLook(false, false)).toEqual({ look: 'app' })
    expect(mailLook(false, true)).toEqual({ look: 'app' })
    for (const html of [designed, plain]) {
      expect(frameDocument(html, 'app')).not.toContain(on)
      expect(frameDocument(html)).toContain('color-scheme: light')
    }
  })

  it('tells markup with colours of its own from markup without', () => {
    expect(wearsAppColours(plain)).toBe(true)
    expect(wearsAppColours('<div style="color:rgb(0,0,0)">hi</div>')).toBe(false)
    expect(wearsAppColours(designed)).toBe(false)
  })

  it('reads how bright a painted background is, and nothing from a see-through one', () => {
    expect(brightness('rgb(255, 255, 255)')).toBeCloseTo(1)
    expect(brightness('rgb(16, 17, 20)')).toBeLessThan(0.35)
    expect(brightness('rgba(0, 0, 0, 0)')).toBeUndefined()
    expect(brightness('transparent')).toBeUndefined()
  })

  it('finds the links in bare text and leaves the full stop after one alone', () => {
    expect(linkParts('Pay at https://example.com/pay?x=1. Or by mail.')).toEqual(['Pay at ', { href: 'https://example.com/pay?x=1' }, '. Or by mail.'])
    expect(linkParts('no links')).toEqual(['no links'])
    expect(linkParts('https://a.example https://b.example')).toEqual([{ href: 'https://a.example' }, ' ', { href: 'https://b.example' }])
  })
})
