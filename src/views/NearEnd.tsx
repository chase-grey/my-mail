import { useEffect, useRef } from 'react'

/** How far ahead of the end of a list the next page is asked for. About two screens, so it is there before the scroll gets to it. */
export const loadAhead = 1500

/** The nearest thing above the node that scrolls, or nothing when the page itself does. */
export function scrollerOf(node: Element): Element | null {
  for (let parent = node.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
    const flow = getComputedStyle(parent).overflowY
    if (flow === 'auto' || flow === 'scroll') return parent
  }
  return null
}

/**
 * The end of a list that has more to load. It asks for the next page when the scroll gets near it, which is
 * straight away when the list is short. After a failed load it is a button, so a failure is not retried in a loop.
 */
export function NearEnd({ busy, failed, onNear }: { busy: boolean; failed: boolean; onNear: () => void }) {
  const mark = useRef<HTMLDivElement>(null)
  const latest = useRef(onNear)
  latest.current = onNear

  // Watching starts again after every load, so a page that did not fill the screen is followed by the next one.
  useEffect(() => {
    const target = mark.current
    if (!target || busy || failed || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) latest.current() },
      { root: scrollerOf(target), rootMargin: `${loadAhead}px 0px` },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [busy, failed])

  if (failed) return <div className="actions"><button className="secondary" type="button" disabled={busy} onClick={onNear}>try again</button></div>
  return <div ref={mark} className="near-end" aria-hidden="true" />
}
