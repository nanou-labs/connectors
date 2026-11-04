# Outlook

A person's own Microsoft mail, calendars and OneDrive file list through
Microsoft Graph: Outlook.com, Hotmail and Live accounts, and work or school
Microsoft 365 accounts. A connector with a command of its own (`outlook`), run
by `runtime/cli`, like [Slack](../slack). Every email, reply, forward, event
change or invitation answer waits for an approval card.

A reply, forward or event change names its target by an id, which means
nothing on a card. So those commands also take what the card shows (`--to`,
`--subject`, `--event`) and check it against the real message or event first:
a reply goes to exactly the people on the card, or nothing is sent.

**Connect:** nanou.ai → Connectors → Outlook shows a code to type on
Microsoft's own sign-in page (`auth.kind: "device"`, the OAuth device code
flow run by nanou's host with the app's client id; no client secret, no
redirect URL). The host writes the tokens into the family's enclave; nothing
but the one-time code passes through nanou.ai. Access tokens last about an
hour and the command renews them itself with the refresh token.

**Scopes** (delegated, the narrowest that work): `offline_access User.Read
Mail.Read Mail.Send Calendars.ReadWrite Files.Read`. No `Mail.ReadWrite`: nanou
can't delete, move or draft mail, only send what a card approved.

**Files:** `~/.config/connectors/outlook/<address>.json`
(`{ address, owner, client_id, scope, access_token, expires_at, refresh_token, connected_at }`).
One person may connect several accounts (`--account <address>`).

**Network:** `graph.microsoft.com` and `login.microsoftonline.com` only. So
OneDrive files are listed with their links, but not downloaded (Microsoft
serves file contents from other hosts).

**Tests:** `node --test "connectors/outlook/test/*.test.mjs"`, against a local
stand-in for Graph and Microsoft's token endpoint.

## The Microsoft app (nanou's host, once)

nanou needs one app registration in Microsoft Entra, a public client with
device code sign-in:

1. [entra.microsoft.com](https://entra.microsoft.com) → Identity → Applications
   → App registrations → New registration. Name: `nanou`. Supported account
   types: **Accounts in any organizational directory and personal Microsoft
   accounts**. Redirect URI: leave it empty. Register.
2. Authentication → Advanced settings → **Allow public client flows: Yes**
   (this turns on the device code flow). Save. No client secret or
   certificate: don't create one.
3. API permissions → Add a permission → Microsoft Graph → **Delegated**:
   `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send`,
   `Calendars.ReadWrite`, `Files.Read`. None of them needs admin consent;
   a work tenant may still require its admin to approve the app.
4. Branding & properties: the publisher domain (nanou.ai), home page,
   terms and privacy links. Verifying the publisher (Microsoft Partner
   Network) removes "unverified" from the consent screen, and some work
   tenants only allow verified publishers.
5. Copy the **Application (client) ID** from Overview into the host's
   `shared/nanou-microsoft-app.json` as `{"client_id": "…"}`. Until it is
   there, the page says Outlook opens soon.
