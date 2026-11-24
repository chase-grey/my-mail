/** The build's entry script as index.html names it. Every deploy gives it a new hashed name. */
export function entryScript(html: string): string | undefined {
  return /<script[^>]+src="([^"]*\/assets\/[^"]+\.js)"/.exec(html)?.[1]
}

/** The published page names a different build than the one running. */
export function isNewBuild(html: string, running: string | undefined): boolean {
  const published = entryScript(html)
  return Boolean(published && running && published !== running)
}

const checkEveryMs = 60_000
const reloadedForKey = 'my-mail.reloaded-for'

/**
 * A tab or installed window stays open for days, and the host lets the browser reuse the page for ten minutes,
 * so a deploy would otherwise wait for a manual hard refresh. On open and on every return, ask for the
 * published page past the cache and reload once when it names a newer build.
 */
export function watchForNewBuild(pageUrl: string): void {
  const running = document.querySelector('script[src*="/assets/"]')?.getAttribute('src') ?? undefined
  if (!running) return
  let checked = 0
  const check = async () => {
    if (document.visibilityState !== 'visible' || Date.now() - checked < checkEveryMs) return
    checked = Date.now()
    try {
      const html = await (await fetch(pageUrl, { cache: 'no-store' })).text()
      const published = entryScript(html)
      // Something half-written in a sheet outlasts the update; one reload per build, so a stale answer cannot loop.
      if (!published || !isNewBuild(html, running) || document.querySelector('dialog[open]') || sessionStorage.getItem(reloadedForKey) === published) return
      sessionStorage.setItem(reloadedForKey, published)
      window.location.reload()
    } catch {
      // Offline, or storage is closed: the running build carries on.
    }
  }
  document.addEventListener('visibilitychange', () => void check())
  window.addEventListener('focus', () => void check())
  void check()
}
