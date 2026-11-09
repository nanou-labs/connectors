package tgc

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gotd/td/telegram/downloader"
	"github.com/gotd/td/telegram/message"
	"github.com/gotd/td/telegram/message/styling"
	"github.com/gotd/td/tg"

	"github.com/nanou-labs/connectors/linked/telegram/tgcli/internal/store"
)

// Target is the chat a write is for: resolved from the store, else (an
// @username nobody has written to yet) looked up on Telegram.
type Target struct {
	Ref  string
	Chat store.Chat
	Ok   bool // Chat was found in the store
}

// resolve returns the target's chat, asking Telegram for an unknown @username.
func resolve(ctx context.Context, api *tg.Client, st *store.Store, t Target) (store.Chat, error) {
	if t.Ok {
		return t.Chat, nil
	}
	if !strings.HasPrefix(t.Ref, "@") {
		return store.Chat{}, fmt.Errorf("no chat %q in the store: %w", t.Ref, store.ErrNotFound)
	}
	res, err := api.ContactsResolveUsername(ctx, &tg.ContactsResolveUsernameRequest{Username: strings.TrimPrefix(t.Ref, "@")})
	if err != nil {
		return store.Chat{}, fmt.Errorf("resolve %s: %w", t.Ref, err)
	}
	p := newPeers()
	p.add(res.Users, res.Chats)
	chat := p.chatOf(res.Peer)
	if chat.Name == "" {
		return store.Chat{}, fmt.Errorf("resolve %s: %w", t.Ref, store.ErrNotFound)
	}
	for _, u := range p.users {
		_ = st.UpsertUser(userRecord(u))
	}
	_ = st.UpsertChat(chat)
	return chat, nil
}

// SendOptions is one `send text` or `send file`.
type SendOptions struct {
	App     App
	Dir     string
	Version string
	Store   *store.Store
	To      Target
	Text    string // the message, or a file's caption
	ReplyTo int
	File    string // a path for `send file`
}

// sentID finds the new message's id in the answer to a send.
func sentID(u tg.UpdatesClass) int {
	var list []tg.UpdateClass
	switch u := u.(type) {
	case *tg.UpdateShortSentMessage:
		return u.ID
	case *tg.Updates:
		list = u.Updates
	case *tg.UpdatesCombined:
		list = u.Updates
	}
	for _, up := range list {
		switch up := up.(type) {
		case *tg.UpdateMessageID:
			return up.ID
		case *tg.UpdateNewMessage:
			return up.Message.GetID()
		case *tg.UpdateNewChannelMessage:
			return up.Message.GetID()
		}
	}
	return 0
}

// Send sends one message (or file) from the person's account and stores it.
func Send(ctx context.Context, o SendOptions) (store.Message, error) {
	me, err := ReadMe(o.Dir)
	if err != nil {
		return store.Message{}, ErrNotLinked
	}
	var chat store.Chat
	var id int
	err = oneShot(ctx, o.App, o.Dir, o.Version, func(ctx context.Context, api *tg.Client) error {
		if chat, err = resolve(ctx, api, o.Store, o.To); err != nil {
			return err
		}
		b := &message.NewSender(api).To(inputPeer(chat)).Builder
		if o.ReplyTo > 0 {
			b = b.Reply(o.ReplyTo)
		}
		var u tg.UpdatesClass
		if o.File != "" {
			var caption []message.StyledTextOption
			if o.Text != "" {
				caption = append(caption, styling.Plain(o.Text))
			}
			name, mt, photo := fileKind(o.File)
			up := b.Upload(message.FromPath(o.File))
			if photo {
				u, err = up.Photo(ctx, caption...)
			} else {
				// A plain upload has no name or type: Telegram shows it as "Unknown.file".
				var f tg.InputFileClass
				if f, err = up.AsInputFile(ctx); err == nil {
					u, err = b.Media(ctx, message.UploadedDocument(f, caption...).Filename(name).MIME(mt).ForceFile(true))
				}
			}
		} else {
			u, err = b.Text(ctx, o.Text)
		}
		if err != nil {
			return err
		}
		id = sentID(u)
		return nil
	})
	if err != nil {
		return store.Message{}, err
	}
	m := store.Message{
		ID: id, ChatID: chat.ID, ChatName: chat.Name, FromID: store.MarkedID(store.KindUser, me.UserID),
		FromName: me.Name, Out: true, Unix: time.Now().Unix(), Text: o.Text, ReplyTo: o.ReplyTo,
	}
	if o.File != "" {
		info, _ := os.Stat(o.File)
		name, mt, photo := fileKind(o.File)
		m.Media = &store.Media{Type: "document", Name: name, Mime: mt}
		if photo {
			m.Media = &store.Media{Type: "photo", Mime: mt}
		}
		if info != nil {
			m.Media.Size = info.Size()
		}
	}
	m.Date = time.Unix(m.Unix, 0).UTC().Format(time.RFC3339)
	if id > 0 {
		// The sync stores it too when it comes back as an update; this makes it readable at once.
		_ = o.Store.UpsertMessage(m)
	}
	return m, nil
}

// photoMax is the largest picture Telegram takes as a photo; bigger ones go as files.
const photoMax = 10 << 20

// fileKind is how a file goes out: its name (given an extension when it has
// none), its type (from the extension, else its first bytes) and whether it
// is a picture to send as a photo.
func fileKind(path string) (name, mimeType string, photo bool) {
	name = filepath.Base(path)
	mimeType = mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	if mimeType == "" {
		if f, err := os.Open(path); err == nil {
			head := make([]byte, 512)
			n, _ := f.Read(head)
			_ = f.Close()
			if mimeType = http.DetectContentType(head[:n]); mimeType == "application/octet-stream" || strings.HasPrefix(mimeType, "text/plain") {
				mimeType = strings.SplitN(mimeType, ";", 2)[0]
			} else if ext := extFor(mimeType); ext != "" && filepath.Ext(name) == "" {
				name += ext
			}
		}
	}
	mimeType = strings.SplitN(mimeType, ";", 2)[0]
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	switch mimeType {
	case "image/jpeg", "image/png", "image/webp":
		info, err := os.Stat(path)
		photo = err == nil && info.Size() <= photoMax
	}
	return name, mimeType, photo
}

// extFor is the usual extension of a type (Go's table lists .jfif first for JPEG).
func extFor(mimeType string) string {
	mimeType = strings.SplitN(mimeType, ";", 2)[0]
	common := map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "application/pdf": ".pdf"}
	if ext, ok := common[mimeType]; ok {
		return ext
	}
	if exts, _ := mime.ExtensionsByType(mimeType); len(exts) > 0 {
		return exts[0]
	}
	return ""
}

// DownloadOptions is one `media download`.
type DownloadOptions struct {
	App     App
	Dir     string
	Version string
	Chat    store.Chat
	ID      int
	Output  string // a file or an existing folder; empty: <account>/media/
}

// fileLocation is where a message's photo or document is, and a file name for it.
func fileLocation(m *tg.Message) (tg.InputFileLocationClass, string, error) {
	switch media := m.Media.(type) {
	case *tg.MessageMediaPhoto:
		ph, ok := media.Photo.(*tg.Photo)
		if !ok {
			return nil, "", errors.New("the photo is no longer available")
		}
		size, _ := largestSize(ph)
		return &tg.InputPhotoFileLocation{ID: ph.ID, AccessHash: ph.AccessHash, FileReference: ph.FileReference, ThumbSize: size},
			fmt.Sprintf("photo-%d.jpg", m.ID), nil
	case *tg.MessageMediaDocument:
		doc, ok := media.Document.(*tg.Document)
		if !ok {
			return nil, "", errors.New("the file is no longer available")
		}
		return &tg.InputDocumentFileLocation{ID: doc.ID, AccessHash: doc.AccessHash, FileReference: doc.FileReference},
			documentName(doc, m.ID), nil
	}
	return nil, "", errors.New("this message has no photo or file to download")
}

// documentName is a safe file name for a document.
func documentName(doc *tg.Document, id int) string {
	for _, a := range doc.Attributes {
		if f, ok := a.(*tg.DocumentAttributeFilename); ok {
			if name := SafeName(f.FileName); name != "" {
				return name
			}
		}
	}
	ext := ".bin"
	if exts, _ := mime.ExtensionsByType(doc.MimeType); len(exts) > 0 {
		ext = exts[0]
	}
	if doc.MimeType == "audio/ogg" {
		ext = ".ogg"
	}
	return fmt.Sprintf("file-%d%s", id, ext)
}

// SafeName keeps the last element of a name someone else chose, with no path in it.
func SafeName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if name == "." || name == ".." || name == "/" || strings.HasPrefix(name, ".") {
		return ""
	}
	return name
}

// Download saves a message's photo or file and answers its path and size.
func Download(ctx context.Context, o DownloadOptions) (string, int64, error) {
	var path string
	err := oneShot(ctx, o.App, o.Dir, o.Version, func(ctx context.Context, api *tg.Client) error {
		ids := []tg.InputMessageClass{&tg.InputMessageID{ID: o.ID}}
		var res tg.MessagesMessagesClass
		var err error
		if o.Chat.Kind == store.KindChannel {
			res, err = api.ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{
				Channel: &tg.InputChannel{ChannelID: o.Chat.RawID, AccessHash: o.Chat.AccessHash}, ID: ids,
			})
		} else {
			res, err = api.MessagesGetMessages(ctx, ids)
		}
		if err != nil {
			return err
		}
		h, ok := res.(history)
		if !ok {
			return store.ErrNotFound
		}
		p := newPeers()
		p.add(h.GetUsers(), h.GetChats())
		var msg *tg.Message
		for _, mc := range h.GetMessages() {
			if m, ok := mc.(*tg.Message); ok && m.ID == o.ID && p.chatOf(m.PeerID).ID == o.Chat.ID {
				msg = m
			}
		}
		if msg == nil {
			return fmt.Errorf("message %d: %w", o.ID, store.ErrNotFound)
		}
		loc, name, err := fileLocation(msg)
		if err != nil {
			return err
		}
		path = o.Output
		switch info, statErr := os.Stat(path); {
		case path == "":
			dir := filepath.Join(o.Dir, "media")
			if err := os.MkdirAll(dir, 0o700); err != nil {
				return err
			}
			path = filepath.Join(dir, strings.TrimPrefix(o.Chat.ID, "-")+"-"+name)
		case statErr == nil && info.IsDir():
			path = filepath.Join(path, name)
		}
		_, err = downloader.NewDownloader().Download(api, loc).ToPath(ctx, path)
		return err
	})
	if err != nil {
		return "", 0, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", 0, err
	}
	abs, _ := filepath.Abs(path)
	return abs, info.Size(), nil
}
