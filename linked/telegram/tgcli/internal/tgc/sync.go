package tgc

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"

	"github.com/nanou-labs/connectors/linked/telegram/tgcli/internal/store"
)

// SyncOptions is one `tgcli sync`.
type SyncOptions struct {
	App     App
	Dir     string
	Version string
	Store   *store.Store
	Follow  bool
	Chats   int   // how many of the latest chats to copy
	History int   // how many of each chat's latest messages to copy
	MaxDB   int64 // stop storing once store.db is this big (0: no cap)
	Logf    func(format string, args ...any)
}

// writer saves what Telegram sends into the store. Message text is never logged.
type writer struct {
	mu      sync.Mutex
	st      *store.Store
	me      Me
	p       *peers
	maxDB   int64
	writes  int
	full    bool
	logf    func(format string, args ...any)
	skipped int
}

// roomLeft checks the size cap now and then (every 200 writes).
func (w *writer) roomLeft() bool {
	if w.full {
		return false
	}
	if w.maxDB <= 0 {
		return true
	}
	w.writes++
	if w.writes%200 == 1 {
		if size, err := w.st.Size(); err == nil && size >= w.maxDB {
			w.full = true
			w.logf("store reached its size cap (%d bytes): not storing new messages", size)
		}
	}
	return !w.full
}

// saveUsers keeps every user the answer named.
func (w *writer) saveUsers() error {
	for _, u := range w.p.users {
		if err := w.st.UpsertUser(userRecord(u)); err != nil {
			return err
		}
	}
	return nil
}

// saveMessages stores messages, adding a chat row for any chat not seen yet.
func (w *writer) saveMessages(msgs []tg.MessageClass) error {
	for _, mc := range msgs {
		m, chat, ok := w.p.messageOf(mc, w.me)
		if !ok {
			continue
		}
		if !w.roomLeft() {
			w.skipped++
			continue
		}
		if _, err := w.st.Chat(chat.ID); errors.Is(err, store.ErrNotFound) && chat.Name != "" {
			if err := w.st.UpsertChat(chat); err != nil {
				return err
			}
		}
		if err := w.st.UpsertMessage(m); err != nil {
			return err
		}
	}
	return nil
}

// onUpdate stores a message from a live update.
func (w *writer) onUpdate(e tg.Entities, msg tg.MessageClass) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.p = newPeers()
	w.p.addEntities(e)
	if err := w.saveUsers(); err != nil {
		return err
	}
	if err := w.saveMessages([]tg.MessageClass{msg}); err != nil {
		w.logf("storing an update failed: %v", err)
	}
	return nil
}

// Sync copies the latest chats and messages, then (with Follow) keeps the
// store current from live updates until ctx ends. It never marks anything
// read and keeps the session offline.
func Sync(ctx context.Context, o SyncOptions) error {
	me, err := ReadMe(o.Dir)
	if err != nil {
		return ErrNotLinked
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	w := &writer{st: o.Store, me: me, p: newPeers(), maxDB: o.MaxDB, logf: o.Logf}
	dispatcher := tg.NewUpdateDispatcher()
	dispatcher.OnNewMessage(func(_ context.Context, e tg.Entities, u *tg.UpdateNewMessage) error {
		return w.onUpdate(e, u.Message)
	})
	dispatcher.OnNewChannelMessage(func(_ context.Context, e tg.Entities, u *tg.UpdateNewChannelMessage) error {
		return w.onUpdate(e, u.Message)
	})
	dispatcher.OnEditMessage(func(_ context.Context, e tg.Entities, u *tg.UpdateEditMessage) error {
		return w.onUpdate(e, u.Message)
	})
	dispatcher.OnEditChannelMessage(func(_ context.Context, e tg.Entities, u *tg.UpdateEditChannelMessage) error {
		return w.onUpdate(e, u.Message)
	})
	var gaps *updates.Manager
	var handler telegram.UpdateHandler
	if o.Follow {
		gaps = updates.New(updates.Config{Handler: dispatcher})
		handler = gaps
	}
	storage := &session.FileStorage{Path: filepath.Join(o.Dir, SessionFile)}
	client := newClient(o.App, storage, o.Version, handler, 15*time.Minute)
	return client.Run(ctx, func(ctx context.Context) error {
		st, err := client.Auth().Status(ctx)
		if err != nil {
			return err
		}
		if !st.Authorized {
			return ErrNotLinked
		}
		api := client.API()
		stayOffline(ctx, api)
		chats, msgs, err := backfill(ctx, api, w, o.Chats, o.History)
		if err != nil {
			return err
		}
		o.Logf("synced %d chats, %d new messages", chats, msgs)
		if w.skipped > 0 {
			o.Logf("%d messages not stored (size cap)", w.skipped)
		}
		if !o.Follow {
			return nil
		}
		return gaps.Run(ctx, api, me.UserID, updates.AuthOptions{
			OnStart: func(context.Context) { o.Logf("following new messages") },
		})
	})
}

// history is the part of a messages.* answer tgcli reads.
type history interface {
	GetMessages() []tg.MessageClass
	GetUsers() []tg.UserClass
	GetChats() []tg.ChatClass
}

// backfill copies the latest maxChats dialogs and, for each, the messages
// newer than what the store has (at most perChat). Answers how many chats
// and messages it saw.
func backfill(ctx context.Context, api *tg.Client, w *writer, maxChats, perChat int) (int, int, error) {
	if maxChats <= 0 {
		maxChats = 200
	}
	if perChat <= 0 {
		perChat = 50
	}
	type dialog struct {
		chat store.Chat
		top  int
	}
	var dialogs []dialog
	var offsetPeer tg.InputPeerClass = &tg.InputPeerEmpty{}
	offsetDate, offsetID := 0, 0
	for len(dialogs) < maxChats {
		limit := min(100, maxChats-len(dialogs))
		res, err := api.MessagesGetDialogs(ctx, &tg.MessagesGetDialogsRequest{
			OffsetPeer: offsetPeer, OffsetDate: offsetDate, OffsetID: offsetID, Limit: limit,
		})
		if err != nil {
			return 0, 0, fmt.Errorf("get chats: %w", err)
		}
		page, ok := res.(interface {
			history
			GetDialogs() []tg.DialogClass
		})
		if !ok {
			break // not modified
		}
		w.mu.Lock()
		w.p = newPeers()
		w.p.add(page.GetUsers(), page.GetChats())
		if err := w.saveUsers(); err != nil {
			w.mu.Unlock()
			return 0, 0, err
		}
		dates := map[string]*tg.Message{}
		for _, mc := range page.GetMessages() {
			if m, ok := mc.(*tg.Message); ok {
				dates[w.p.chatOf(m.PeerID).ID] = m
			} else if m, ok := mc.(*tg.MessageService); ok {
				dates[w.p.chatOf(m.PeerID).ID] = &tg.Message{ID: m.ID, Date: m.Date, PeerID: m.PeerID}
			}
		}
		var last dialog
		var lastMsg *tg.Message
		for _, dc := range page.GetDialogs() {
			d, ok := dc.(*tg.Dialog)
			if !ok {
				continue
			}
			chat := w.p.chatOf(d.Peer)
			if chat.ID == "" {
				continue
			}
			chat.Unread = d.UnreadCount
			if m := dates[chat.ID]; m != nil {
				chat.SetLast(int64(m.Date))
				lastMsg = m
			}
			if err := w.st.UpsertChat(chat); err != nil {
				w.mu.Unlock()
				return 0, 0, err
			}
			last = dialog{chat: chat, top: d.TopMessage}
			dialogs = append(dialogs, last)
		}
		w.mu.Unlock()
		if len(page.GetDialogs()) < limit || lastMsg == nil {
			break
		}
		offsetPeer, offsetDate, offsetID = inputPeer(last.chat), lastMsg.Date, lastMsg.ID
	}
	saved := 0
	for _, d := range dialogs {
		have, err := w.st.LastMessageID(d.chat.ID)
		if err != nil {
			return 0, 0, err
		}
		if d.top <= have {
			continue
		}
		res, err := api.MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{
			Peer: inputPeer(d.chat), Limit: perChat, MinID: have,
		})
		if err != nil {
			// One chat that can't be read (left, banned) doesn't stop the rest.
			w.logf("skipping a chat: %v", err)
			continue
		}
		h, ok := res.(history)
		if !ok {
			continue
		}
		w.mu.Lock()
		w.p = newPeers()
		w.p.add(h.GetUsers(), h.GetChats())
		err = w.saveUsers()
		if err == nil {
			err = w.saveMessages(h.GetMessages())
		}
		w.mu.Unlock()
		if err != nil {
			return 0, 0, err
		}
		saved += len(h.GetMessages())
	}
	return len(dialogs), saved, nil
}
