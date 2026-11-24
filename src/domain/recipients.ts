export type Recipient = { name?: string; address: string }

const address = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/

/** What was typed in a to or cc field. Commas, semicolons, and new lines separate; `Name <a@b.c>` keeps the address. */
export function parseRecipients(typed: string): { recipients: Recipient[]; invalid: string[] } {
  const recipients: Recipient[] = []
  const invalid: string[] = []
  for (const part of typed.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)) {
    const bracketed = part.match(/^(.*)<([^<>]+)>$/)
    const found = (bracketed ? bracketed[2] : part).trim().toLowerCase()
    const name = bracketed?.[1].trim().replace(/^"|"$/g, '').trim()
    if (!address.test(found)) { invalid.push(part); continue }
    if (recipients.some((item) => item.address === found)) continue
    recipients.push(name ? { name, address: found } : { address: found })
  }
  return { recipients, invalid }
}

export const formatRecipients = (list: Recipient[]) => list.map((item) => item.address).join(', ')

/** The fields show addresses alone; a name known for one goes back on before it is sent. */
export function withNames(list: Recipient[], known: Recipient[]): Recipient[] {
  const names = new Map(known.filter((item) => item.name && item.name !== item.address).map((item) => [item.address.toLowerCase(), item.name]))
  return list.map((item) => item.name || !names.has(item.address) ? item : { ...item, name: names.get(item.address) })
}

export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kb`
  return `${(bytes / 1024 / 1024).toFixed(1)} mb`
}
