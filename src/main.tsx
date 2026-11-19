import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/** Microsoft sends the sign-in popup back to this page with the result in the url. */
function isSignInResponse(): boolean {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search)
  return params.has('state') && (params.has('code') || params.has('error'))
}

if (isSignInResponse()) {
  // msal 5 no longer reads the popup from the opener: the popup has to hand the result back itself, then it closes.
  void import('@azure/msal-browser/redirect-bridge').then((bridge) => bridge.broadcastResponseToMainFrame())
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
        scope: import.meta.env.BASE_URL,
      }).catch(() => {
        // Offline support is progressive enhancement.
      })
    })
  }
}
