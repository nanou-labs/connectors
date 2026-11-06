# Instagram

A person's own Instagram **professional** account (Creator or Business),
through the Instagram API with Instagram Login: their profile, posts and
reels, and the comments on them. A connector with a command of its own
(`instagram`), run by `runtime/cli`, like [Outlook](../outlook). Every post,
carousel, reel, reply, hidden or deleted comment waits for an approval card.
No direct messages, stories, ads or insights.

A reply or comment change names its comment by an id, which means nothing on a
card. So those commands also take who wrote it (`--to`, `--from`) and its
words (`--quote`), and check both against the real comment first.

**Connect:** nanou.ai → Connectors → Instagram opens Instagram's own sign-in
page (`auth.kind: "oauth2"`, the authorization-code flow). nanou's host keeps
the app's secret and redeems the one-time code: only that code passes through
nanou.ai. The host exchanges it for a long-lived token (60 days) and writes it
into the family's enclave. The command renews it there, with the token alone,
when it has under a week left. A token left unused for 60 days expires, and
the person connects again.

**Scopes:** `instagram_business_basic`, `instagram_business_content_publish`,
`instagram_business_manage_comments`. Nothing for messages or insights.

**Posting:** Instagram fetches the media itself from a public HTTPS address.
A post therefore takes a nanou media link (`https://relay.nanou.ai/v1/media/…`,
made by `media-link <file>` in the family's container): an unguessable
address that serves that one file for an hour, then is deleted (or at once
with `media-link done`). The command refuses any other address. Photos are
converted to JPEG on the way, as Instagram requires.

**Files:** `~/.config/connectors/instagram/<username>.json`
(`{ username, user_id, owner, scope, access_token, expires_at, refreshed_at, connected_at }`).
One person may connect several accounts (`--account <username>`).

**Network:** `graph.instagram.com`, `api.instagram.com`, `www.instagram.com`, and `relay.nanou.ai`, the host of the media links it posts (Instagram fetches them; the command itself never does).

**Limits:** Instagram allows 100 posts through apps per account per 24 hours
(`instagram quota`). Reels are processed by Instagram before they can be
published; the command waits up to 4 minutes.

**Tests:** `node --test "connectors/instagram/test/*.test.mjs"`, against a local
stand-in for the Instagram API.

## The Meta app (nanou's host, once)

nanou needs one Meta app with the Instagram product and **Instagram Login**
(not Facebook Login): its redirect URL is nanou.ai's
`/api/connect/instagram/callback`, and its Instagram app id and secret live
on nanou's host only. Until Meta's App Review grants Advanced Access, only
accounts added as Instagram testers of the app can connect.
