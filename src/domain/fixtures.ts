import type { Message } from './types'

export const message = (id: string, address: string, subject = 'hello', extra: Partial<Message> = {}): Message => ({
  id, subject, from: { name: address.split('@')[0], address }, receivedAt: `2026-11-0${(Number(id.replace(/\D/g, '')) % 9) + 1}T09:00:00Z`,
  preview: '', body: '', isRead: false, flagged: false, importance: 'normal', hasAttachments: false, categories: [], webLink: `https://outlook.live.com/${id}`, ...extra,
})
