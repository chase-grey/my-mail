/**
 * Where My Brain opens its chat about one message. Only the id goes along: My Brain reads the conversation
 * from the mailbox itself, so nothing a message says ever sits in a link.
 */
export function brainChatUrl(brainUrl: string, messageId: string): string {
  return `${brainUrl.trim().replace(/#.*$/, '')}#chat/mail/${encodeURIComponent(messageId)}`
}
