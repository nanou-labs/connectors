# Slack

Reads a person's Slack (channels, DMs, threads, search, people) with their
own user token, and posts or reacts as them only after an approval card. A
connector with a command of its own (`slack`), run by `runtime/cli`, like
[Asana](../asana).

**Connect:** at api.slack.com/apps create an app from scratch in the
workspace, add these **user token scopes** under OAuth & Permissions, install
it (a workspace admin may have to approve it) and paste the User OAuth Token
(`xoxp-…`) on nanou.ai → Connectors → Slack:

`channels:read groups:read im:read mpim:read channels:history groups:history im:history mpim:history search:read users:read users:read.email chat:write im:write reactions:write`

`slack whoami` lists what the token can and can't do.

**Files:** `slack-<owner>.json` (`{ token }`) in `~/.config/family-work`, and
a day-long cache of the workspace's people in `slack-state/`.

**Tests:** `node --test "connectors/slack/test/*.test.mjs"`, against a local
stand-in for Slack's Web API.
