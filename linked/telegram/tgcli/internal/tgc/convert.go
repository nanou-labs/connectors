package tgc

import (
	"strconv"

	"github.com/gotd/td/tg"

	"github.com/nanou-labs/connectors/linked/telegram/tgcli/internal/store"
)

// peers are the users, groups and channels a Telegram answer mentions.
type peers struct {
	users    map[int64]*tg.User
	chats    map[int64]*tg.Chat
	channels map[int64]*tg.Channel
}

func newPeers() *peers {
	return &peers{users: map[int64]*tg.User{}, chats: map[int64]*tg.Chat{}, channels: map[int64]*tg.Channel{}}
}

// add records the users and chats of an answer.
func (p *peers) add(users []tg.UserClass, chats []tg.ChatClass) {
	for _, u := range users {
		if u, ok := u.(*tg.User); ok {
			p.users[u.ID] = u
		}
	}
	for _, c := range chats {
		switch c := c.(type) {
		case *tg.Chat:
			p.chats[c.ID] = c
		case *tg.Channel:
			p.channels[c.ID] = c
		}
	}
}

// addEntities records an update's entities.
func (p *peers) addEntities(e tg.Entities) {
	for id, u := range e.Users {
		p.users[id] = u
	}
	for id, c := range e.Chats {
		p.chats[id] = c
	}
	for id, c := range e.Channels {
		p.channels[id] = c
	}
}

// userRecord is a user as the store keeps them.
func userRecord(u *tg.User) store.User {
	return store.User{
		ID: u.ID, AccessHash: u.AccessHash, Name: userName(u), Username: u.Username,
		Phone: u.Phone, Contact: u.Contact,
	}
}

// userName is how a user reads: their name, else @username, else their number.
func userName(u *tg.User) string {
	if n := FullName(u.FirstName, u.LastName); n != "" {
		return n
	}
	if u.Username != "" {
		return "@" + u.Username
	}
	if u.Phone != "" {
		return "+" + u.Phone
	}
	if u.Deleted {
		return "Deleted account"
	}
	return strconv.FormatInt(u.ID, 10)
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// chatOf is the store's chat for a peer (Name empty when the peer is unknown).
func (p *peers) chatOf(peer tg.PeerClass) store.Chat {
	switch peer := peer.(type) {
	case *tg.PeerUser:
		c := store.Chat{ID: store.MarkedID(store.KindUser, peer.UserID), Kind: store.KindUser, RawID: peer.UserID, Type: "user"}
		if u := p.users[peer.UserID]; u != nil {
			c.Name, c.AccessHash, c.Username, c.Phone = userName(u), u.AccessHash, strPtr(u.Username), u.Phone
			if u.Self {
				c.Name = "Saved Messages"
			}
		}
		return c
	case *tg.PeerChat:
		c := store.Chat{ID: store.MarkedID(store.KindChat, peer.ChatID), Kind: store.KindChat, RawID: peer.ChatID, Type: "group"}
		if ch := p.chats[peer.ChatID]; ch != nil {
			c.Name = ch.Title
		}
		return c
	case *tg.PeerChannel:
		c := store.Chat{ID: store.MarkedID(store.KindChannel, peer.ChannelID), Kind: store.KindChannel, RawID: peer.ChannelID, Type: "channel"}
		if ch := p.channels[peer.ChannelID]; ch != nil {
			c.Name, c.AccessHash, c.Username = ch.Title, ch.AccessHash, strPtr(ch.Username)
			c.Type = store.ChatType(store.KindChannel, ch.Megagroup)
		}
		return c
	}
	return store.Chat{}
}

// senderOf is who wrote a message: its from_id, else the private chat's other side (or me).
func (p *peers) senderOf(m *tg.Message, me Me) (id, name string) {
	from, ok := m.GetFromID()
	if !ok {
		if m.Out {
			return strconv.FormatInt(me.UserID, 10), me.Name
		}
		from = m.PeerID
	}
	c := p.chatOf(from)
	if c.Kind == store.KindUser && c.RawID == me.UserID {
		return c.ID, me.Name
	}
	return c.ID, c.Name
}

// messageOf is the store's message for a Telegram message (false for service messages and the like).
func (p *peers) messageOf(mc tg.MessageClass, me Me) (store.Message, store.Chat, bool) {
	m, ok := mc.(*tg.Message)
	if !ok {
		return store.Message{}, store.Chat{}, false
	}
	chat := p.chatOf(m.PeerID)
	if chat.ID == "" {
		return store.Message{}, store.Chat{}, false
	}
	fromID, fromName := p.senderOf(m, me)
	msg := store.Message{
		ID: m.ID, ChatID: chat.ID, ChatName: chat.Name, FromID: fromID, FromName: fromName,
		Out: m.Out, Unix: int64(m.Date), Text: m.Message, Media: mediaOf(m.Media),
	}
	if r, ok := m.ReplyTo.(*tg.MessageReplyHeader); ok {
		msg.ReplyTo = r.ReplyToMsgID
	}
	return msg, chat, true
}

// mediaOf describes a message's attachment (nil for none, and for a link preview).
func mediaOf(mc tg.MessageMediaClass) *store.Media {
	switch m := mc.(type) {
	case nil, *tg.MessageMediaEmpty, *tg.MessageMediaWebPage:
		return nil
	case *tg.MessageMediaPhoto:
		media := &store.Media{Type: "photo", Name: "photo.jpg", Mime: "image/jpeg"}
		if ph, ok := m.Photo.(*tg.Photo); ok {
			_, media.Size = largestSize(ph)
		}
		return media
	case *tg.MessageMediaDocument:
		media := &store.Media{Type: "document"}
		doc, ok := m.Document.(*tg.Document)
		if !ok {
			return media
		}
		media.Size, media.Mime = doc.Size, doc.MimeType
		for _, a := range doc.Attributes {
			switch a := a.(type) {
			case *tg.DocumentAttributeFilename:
				media.Name = a.FileName
			case *tg.DocumentAttributeAudio:
				if a.Voice {
					media.Type = "voice"
				} else {
					media.Type = "audio"
				}
			case *tg.DocumentAttributeVideo:
				if a.RoundMessage {
					media.Type = "video_note"
				} else {
					media.Type = "video"
				}
			case *tg.DocumentAttributeSticker:
				media.Type = "sticker"
			case *tg.DocumentAttributeAnimated:
				media.Type = "gif"
			}
		}
		return media
	case *tg.MessageMediaContact:
		return &store.Media{Type: "contact", Name: FullName(m.FirstName, m.LastName)}
	case *tg.MessageMediaGeo, *tg.MessageMediaGeoLive, *tg.MessageMediaVenue:
		return &store.Media{Type: "location"}
	case *tg.MessageMediaPoll:
		return &store.Media{Type: "poll"}
	default:
		return &store.Media{Type: "other"}
	}
}

// largestSize is a photo's biggest size: its type letter and byte count.
func largestSize(ph *tg.Photo) (string, int64) {
	var kind string
	var best int64
	for _, s := range ph.Sizes {
		switch s := s.(type) {
		case *tg.PhotoSize:
			if int64(s.Size) >= best {
				kind, best = s.Type, int64(s.Size)
			}
		case *tg.PhotoSizeProgressive:
			if n := len(s.Sizes); n > 0 && int64(s.Sizes[n-1]) >= best {
				kind, best = s.Type, int64(s.Sizes[n-1])
			}
		}
	}
	return kind, best
}

// inputPeer is how Telegram is told which chat a call is about.
func inputPeer(c store.Chat) tg.InputPeerClass {
	switch c.Kind {
	case store.KindUser:
		return &tg.InputPeerUser{UserID: c.RawID, AccessHash: c.AccessHash}
	case store.KindChat:
		return &tg.InputPeerChat{ChatID: c.RawID}
	default:
		return &tg.InputPeerChannel{ChannelID: c.RawID, AccessHash: c.AccessHash}
	}
}
