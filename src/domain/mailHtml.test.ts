import { describe, expect, it } from 'vitest'
import { knownSenders } from './rules'
import { brightness, darkened, frameDocument, framePolicy, linkParts, loadsRemote, mailLook, wantsRemote, wearsAppColours } from './mailHtml'

const designed = '<html><body><table bgcolor="#ffffff"><tr><td style="color:#222222">sale</td></tr></table></body></html>'
const plain = '<p>Does <b>five</b> work?</p>'
const on = `<html class="${darkened}">`

describe('mail markup for reading', () => {
  it('puts the policy ahead of anything the message brings and opens links in a new tab', () => {
    const page = frameDocument('<html><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0; url=https://evil.example/"></head><body><p>hi</p></body></html>')
    expect(page.indexOf(framePolicy())).toBeGreaterThan(0)
    expect(page.indexOf(framePolicy())).toBeLessThan(page.indexOf('<html>'))
    expect(page.indexOf('<base target="_blank">')).toBeLessThan(page.indexOf('evil.example'))
    expect(page).not.toMatch(/http-equiv="refresh"/i)
    expect(page).toContain('<p>hi</p>')
    for (const policy of [framePolicy(), framePolicy(true)]) expect(policy).not.toMatch(/script|frame|connect/)
  })

  it('loads nothing from elsewhere unless it is told to, and then only pictures and fonts over https', () => {
    expect(framePolicy()).toBe("default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:")
    expect(framePolicy(true)).toBe("default-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline'; font-src https: data:")
    for (const policy of [framePolicy(), framePolicy(true)]) expect(policy).not.toMatch(/http:|\*|blob:/)
    const tracked = '<p>hi</p><img src="https://track.example/pixel.gif?id=me" width="1" height="1">'
    expect(frameDocument(tracked)).toContain(`content="${framePolicy()}"`)
    expect(frameDocument(tracked, 'dark')).toContain(`content="${framePolicy()}"`)
    expect(frameDocument(tracked, 'app', true)).toContain(`content="${framePolicy(true)}"`)
    // One policy, and it is ours: the message cannot loosen it with a second.
    expect(frameDocument(tracked).match(/Content-Security-Policy/g)).toHaveLength(1)
  })

  it('knows when a message asks for something from elsewhere, so the button shows only then', () => {
    for (const html of [
      '<img src="https://track.example/p.gif">',
      "<IMG SRC = 'http://track.example/p.gif'>",
      '<img src=//track.example/p.gif>',
      '<img srcset="https://shop.example/a.png 2x">',
      '<table background="https://shop.example/bg.png">',
      '<div style="background-image:url(https://shop.example/bg.png)">',
      '<div style="background:url(&quot;https://shop.example/bg.png&quot;)">',
      "<style>@font-face { font-family: x; src: url('https://shop.example/x.woff2'); }</style>",
    ]) expect(wantsRemote(html), html).toBe(true)
    for (const html of [
      '<p>See <a href="https://example.com/album">the album</a></p>',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="cid:logo@shop.example">',
      '<p>plain</p>',
    ]) expect(wantsRemote(html), html).toBe(false)
  })

  it('loads pictures on opening only for people I know, never for mail from junk, and for anyone once asked', () => {
    const known = knownSenders([
      { messageId: '1', from: 'mom@example.com', action: 'reply', at: 't' },
      { messageId: '2', from: 'owen@example.com', action: 'keep', at: 't' },
      { messageId: '3', from: 'news@daily.example.com', action: 'archive', at: 't' },
      { messageId: '4', from: 'deals@shop.example.com', action: 'delete', at: 't' },
      { messageId: '5', from: 'list@club.example.com', action: 'unsubscribe', at: 't' },
    ])
    expect([...known].sort()).toEqual(['mom@example.com', 'owen@example.com'])
    expect(loadsRemote({}, true, false)).toBe(true)
    expect(loadsRemote({}, false, false)).toBe(false)
    expect(loadsRemote({ fromJunk: true }, true, false)).toBe(false)
    // `load images` was pressed on this message.
    expect(loadsRemote({}, false, true)).toBe(true)
    expect(loadsRemote({ fromJunk: true }, true, true)).toBe(true)
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
