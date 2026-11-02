import { actions, categories, type Action, type Category, type Message, type Triage } from '../domain/types'
import { textOf, toolUses, type AnthropicClient, type AnthropicTool, type MessagesRequest, type ToolChoice } from './anthropicClient'

export const batchSize = 12

export type TriagePrompt = {
  aboutMe: string
  today: string
  /** One line per message id about how I have treated the sender, when there is any history. */
  history?: (message: Message) => string
}

/** A message the model is asked to read, with what is already known about it. */
export type ReadItem = { message: Message; known?: Pick<Triage, 'category' | 'needsReply'> }

const triageTool: AnthropicTool = {
  name: 'triage_messages',
  description: 'Return one verdict per message, in any order, using the message numbers given.',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', description: 'the message number' },
            category: { type: 'string', enum: [...categories], description: 'reply: a person is waiting on me. action: I must do something but not reply. waiting: I am waiting on them. fyi: worth knowing, nothing to do. receipt: order or payment confirmation. notification: automated service message. newsletter: subscribed content. promo: marketing. spam: unwanted.' },
            summary: { type: 'string', description: 'one short lowercase line: what it is and what, if anything, it wants from me' },
            needs_reply: { type: 'boolean' },
            suggested: { type: 'string', enum: ['archive', 'task', 'reply', 'keep', 'delete'], description: 'archive when nothing is needed, task when something must be done later, reply when a person is waiting, keep when it should stay in the inbox for now, delete for junk' },
            task: { type: 'string', description: 'when suggested is task: a short imperative task title' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['n', 'category', 'summary', 'needs_reply', 'suggested', 'confidence'],
        },
      },
    },
    required: ['results'],
  },
}

export function systemPrompt(context: TriagePrompt): string {
  return [
    'You triage the personal inbox of one person. For each message decide what it is and what it needs. Be decisive and brief.',
    `Today is ${context.today}.`,
    context.aboutMe.trim() ? `About the person, in their words: ${context.aboutMe.trim()}` : '',
    'Mail from a real person asking something is a reply even when it is casual. Automated mail is never a reply.',
    'When a message comes with a known category, keep it unless the text plainly contradicts it.',
    'Lowercase for summaries and task titles.',
  ].filter(Boolean).join('\n')
}

export function messagesText(items: ReadItem[], history?: (message: Message) => string): string {
  return items.map(({ message, known }, index) => [
    `### message ${index + 1}`,
    `from: ${message.from.name} <${message.from.address}>`,
    `received: ${message.receivedAt}`,
    `subject: ${message.subject}`,
    known ? `known category: ${known.category}${known.needsReply ? ', needs a reply' : ''}` : '',
    message.flagged ? 'flagged: yes' : '',
    message.importance === 'high' ? 'importance: high' : '',
    message.hasAttachments ? 'attachments: yes' : '',
    history?.(message) ?? '',
    '',
    message.body || message.preview || '(empty)',
  ].filter((line) => line !== '').join('\n')).join('\n\n')
}

/** Haiku still takes a forced tool call; the newer Sonnet and Opus reject it and are steered from the prompt instead. */
export function toolChoiceFor(model: string, tool: string): ToolChoice {
  return model.startsWith('claude-haiku') ? { type: 'tool', name: tool } : { type: 'auto' }
}

export function buildRequest(model: string, items: ReadItem[], context: TriagePrompt): MessagesRequest {
  const forced = toolChoiceFor(model, triageTool.name)
  return {
    model,
    max_tokens: 2048,
    system: systemPrompt(context),
    tools: [triageTool],
    tool_choice: forced,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: `${forced.type === 'auto' ? `Call ${triageTool.name} once with every message. ` : ''}Triage these ${items.length} messages.\n\n${messagesText(items, context.history)}` }],
  }
}

type RawResult = {
  n?: unknown
  category?: unknown
  summary?: unknown
  needs_reply?: unknown
  suggested?: unknown
  task?: unknown
  confidence?: unknown
}

const isCategory = (value: unknown): value is Category => typeof value === 'string' && (categories as readonly string[]).includes(value)
const isAction = (value: unknown): value is Action => typeof value === 'string' && (actions as readonly string[]).includes(value)

/** Keep only verdicts for messages we asked about, with every field made safe. A known category wins over the model's. */
export function parseResults(input: unknown, items: ReadItem[], triagedAt: string): Triage[] {
  const raw = input && typeof input === 'object' && Array.isArray((input as { results?: unknown }).results) ? (input as { results: RawResult[] }).results : []
  const seen = new Set<number>()
  const results: Triage[] = []
  for (const item of raw) {
    const n = typeof item.n === 'number' ? item.n : typeof item.n === 'string' ? Number.parseInt(item.n, 10) : Number.NaN
    if (!Number.isInteger(n) || n < 1 || n > items.length || seen.has(n)) continue
    seen.add(n)
    const { message, known } = items[n - 1]
    const category = known?.category ?? (isCategory(item.category) ? item.category : 'fyi')
    const needsReply = known?.needsReply ?? (item.needs_reply === true || category === 'reply')
    const suggested = isAction(item.suggested) ? item.suggested : needsReply ? 'reply' : 'keep'
    const confidence = known ? 1 : typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? Math.min(1, Math.max(0, item.confidence)) : 0.5
    results.push({
      messageId: message.id,
      category,
      summary: typeof item.summary === 'string' ? item.summary.trim() : '',
      needsReply,
      suggested,
      task: typeof item.task === 'string' && item.task.trim() ? item.task.trim() : undefined,
      confidence,
      source: 'model',
      triagedAt,
    })
  }
  return results
}

export function batches<T>(items: T[], size = batchSize): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

/** Read messages in batches. Items with a known category get a summary and a suggestion; the rest get a full verdict. */
export async function readMessages(client: AnthropicClient, model: string, items: ReadItem[], context: TriagePrompt, now = () => new Date().toISOString()): Promise<Triage[]> {
  const results: Triage[] = []
  for (const batch of batches(items)) {
    const response = await client.createMessage(buildRequest(model, batch, context))
    const use = toolUses(response.content).find((block) => block.name === triageTool.name)
    results.push(...parseResults(use?.input, batch, now()))
  }
  return results
}

export const triageMessages = (client: AnthropicClient, model: string, messages: Message[], context: TriagePrompt, now?: () => string): Promise<Triage[]> =>
  readMessages(client, model, messages.map((message) => ({ message })), context, now)

export type DraftPrompt = TriagePrompt & { instruction?: string }

export function draftSystemPrompt(context: DraftPrompt): string {
  return [
    'You write email replies for one person, in their voice. Reply with the message body only: no subject line, no greeting line like "Subject:", no signature, no commentary.',
    `Today is ${context.today}.`,
    context.aboutMe.trim() ? `About the person, in their words: ${context.aboutMe.trim()}` : '',
    'Short and warm. Answer what was asked. Never invent facts, dates, or commitments the message does not support; when something is unknown, leave a bracketed blank like [date].',
  ].filter(Boolean).join('\n')
}

export function buildDraftRequest(model: string, message: Message, context: DraftPrompt): MessagesRequest {
  return {
    model,
    max_tokens: 1024,
    system: draftSystemPrompt(context),
    messages: [{ role: 'user', content: [
      context.instruction?.trim() ? `What I want to say: ${context.instruction.trim()}` : 'Write the reply I would send.',
      '',
      `from: ${message.from.name} <${message.from.address}>`,
      `subject: ${message.subject}`,
      '',
      message.body || message.preview || '(empty)',
    ].join('\n') }],
  }
}

/** A reply, written only when asked for. Output is the expensive half of a model call, so no draft is made speculatively. */
export async function draftReply(client: AnthropicClient, model: string, message: Message, context: DraftPrompt): Promise<string> {
  const response = await client.createMessage(buildDraftRequest(model, message, context))
  return textOf(response.content)
}
