import { expect, it } from 'vitest'
import { brainChatUrl } from './brain'

it('opens my brain on its chat with the message id and nothing else', () => {
  expect(brainChatUrl('https://example.github.io/my-brain/', 'AQMk/ab+c=')).toBe('https://example.github.io/my-brain/#chat/mail/AQMk%2Fab%2Bc%3D')
  expect(brainChatUrl(' https://example.github.io/my-brain/#today ', 'a')).toBe('https://example.github.io/my-brain/#chat/mail/a')
})
