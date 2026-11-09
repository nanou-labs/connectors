// Package store is tgcli's local copy of an account's chats and messages:
// one SQLite file per account (WAL, so `sync` writes while reads and sends
// run), with an FTS5 index for `messages search`. Read commands only ever
// touch this file, never the network.
package store

import (
	"fmt"
	"strconv"
	"strings"
)

// Peer kinds, as Telegram's API tells them apart.
const (
	KindUser    = "user"
	KindChat    = "chat"    // a basic group
	KindChannel = "channel" // a channel or a supergroup
)

// channelBase is the Bot API offset of channel ids: -100<id> as a number.
const channelBase = 1_000_000_000_000

// MarkedID is a peer's id as the Bot API writes it, as a string: a user is
// its id, a basic group -id, and a channel or supergroup -(10^12 + id).
func MarkedID(kind string, id int64) string {
	switch kind {
	case KindChat:
		return strconv.FormatInt(-id, 10)
	case KindChannel:
		return strconv.FormatInt(-(channelBase + id), 10)
	default:
		return strconv.FormatInt(id, 10)
	}
}

// ParseMarkedID splits a marked id back into its kind and raw id.
func ParseMarkedID(s string) (kind string, id int64, err error) {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || n == 0 {
		return "", 0, fmt.Errorf("not a chat id: %q", s)
	}
	switch {
	case n > 0:
		return KindUser, n, nil
	case n < -channelBase:
		return KindChannel, -n - channelBase, nil
	default:
		return KindChat, -n, nil
	}
}

// ChatType is how a chat reads in tgcli's output: user, group or channel.
// A supergroup (a channel with the megagroup flag) is a group.
func ChatType(kind string, megagroup bool) string {
	switch {
	case kind == KindUser:
		return "user"
	case kind == KindChat, megagroup:
		return "group"
	default:
		return "channel"
	}
}

// Digits keeps the digits of a phone number ("+33 6 12" -> "33612").
func Digits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
