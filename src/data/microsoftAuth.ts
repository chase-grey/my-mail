import {
  BrowserCacheLocation,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser'

/** Same Entra registration as My Brain; this app asks for the mail scopes My Brain never requests. */
export const mailScopes = [
  'Mail.ReadWrite',
  'Mail.Send',
  'MailboxSettings.ReadWrite',
  'Tasks.ReadWrite',
  'Files.ReadWrite.AppFolder',
] as const

export class MicrosoftAuth {
  private constructor(private readonly client: PublicClientApplication) {}

  static async create(
    clientId: string,
    redirectUri = `${window.location.origin}${import.meta.env.BASE_URL}`,
  ): Promise<MicrosoftAuth> {
    const client = new PublicClientApplication({
      auth: {
        clientId,
        authority: 'https://login.microsoftonline.com/consumers',
        redirectUri,
      },
      cache: { cacheLocation: BrowserCacheLocation.LocalStorage },
    })
    await client.initialize()
    return new MicrosoftAuth(client)
  }

  account(): AccountInfo | undefined {
    return this.client.getActiveAccount() ?? this.client.getAllAccounts()[0]
  }

  async signIn(): Promise<AccountInfo> {
    const result = await this.client.loginPopup({ scopes: [...mailScopes] })
    this.client.setActiveAccount(result.account)
    return result.account
  }

  async signOut(): Promise<void> {
    const account = this.account()
    if (account) await this.client.logoutPopup({ account })
  }

  async accessToken(): Promise<string> {
    const account = this.account()
    if (!account) throw new InteractionRequiredAuthError('sign_in_required', 'connect a microsoft account first')
    const result = await this.client.acquireTokenSilent({ account, scopes: [...mailScopes] })
    return result.accessToken
  }
}

export function configuredClientId(): string | undefined {
  const value = import.meta.env.VITE_MICROSOFT_CLIENT_ID?.trim()
  return value || undefined
}
