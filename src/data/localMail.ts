/** Everything this app keeps on the device is under this prefix. */
const prefix = 'my-mail.'

/**
 * What stays on the device when the mailbox is disconnected: settings with their keys, and how the app looks and opens.
 * None of it holds mail or a sender's address. A new key that should outlive a disconnect is added here; any other is forgotten.
 */
export const keptAfterDisconnect: readonly string[] = ['my-mail.settings.v1', 'my-mail.accent', 'my-mail.install-dismissed', 'my-mail.folder.v1']

/**
 * Removes what the app learned from the mailbox and kept on this device: the saved inbox, verdicts, kept mail,
 * rules and decisions about senders, sender kinds, and past searches. Returns the keys it removed.
 */
export function forgetMail(storage: Pick<Storage, 'length' | 'key' | 'removeItem'> | undefined = globalThis.localStorage): string[] {
  try {
    if (!storage) return []
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    const gone = keys.filter((key): key is string => Boolean(key?.startsWith(prefix)) && !keptAfterDisconnect.includes(key!))
    for (const key of gone) storage.removeItem(key)
    return gone
  } catch {
    // Storage can be unavailable; there is then nothing kept to remove.
    return []
  }
}
