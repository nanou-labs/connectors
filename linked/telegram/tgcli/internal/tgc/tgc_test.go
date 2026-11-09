package tgc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"

	"github.com/nanou-labs/connectors/linked/telegram/tgcli/internal/store"
)

func TestLoadApp(t *testing.T) {
	home := t.TempDir()
	t.Setenv("TGCLI_API_ID", "")
	t.Setenv("TGCLI_API_HASH", "")
	if _, err := LoadApp(home); !errors.Is(err, ErrNoApp) {
		t.Fatalf("no app: %v", err)
	}
	_ = os.MkdirAll(filepath.Join(home, ".config", "tgcli"), 0o700)
	_ = os.WriteFile(filepath.Join(home, ".config", "tgcli", "app.json"), []byte(`{"api_id": 12345, "api_hash": "abc"}`), 0o600)
	if app, err := LoadApp(home); err != nil || app.ID != 12345 || app.Hash != "abc" {
		t.Fatalf("file: %+v %v", app, err)
	}
	t.Setenv("TGCLI_API_ID", "7")
	t.Setenv("TGCLI_API_HASH", "h")
	if app, _ := LoadApp(home); app.ID != 7 || app.Hash != "h" {
		t.Fatalf("env wins: %+v", app)
	}
}

func TestErrorKinds(t *testing.T) {
	cases := map[string]error{
		"flood_wait":         fmt.Errorf("send code: %w", &FloodError{Seconds: 120}),
		"password_flood":     passwordFlood{&FloodError{Seconds: 30}},
		"phone_invalid":      fmt.Errorf("send code: %w", tgerr.New(400, "PHONE_NUMBER_INVALID")),
		"phone_banned":       tgerr.New(400, "PHONE_NUMBER_BANNED"),
		"code_expired":       tgerr.New(400, "PHONE_CODE_EXPIRED"),
		"app_missing":        ErrNoApp,
		"phone_unregistered": ErrUnregistered,
		"timeout":            context.DeadlineExceeded,
		"other":              errors.New("boom"),
	}
	for want, err := range cases {
		if got, _ := ErrorKind(err); got != want {
			t.Fatalf("ErrorKind(%v) = %s, want %s", err, got, want)
		}
	}
	if _, secs := ErrorKind(&FloodError{Seconds: 120}); secs != 120 {
		t.Fatalf("seconds %d", secs)
	}
}

func TestLinkedAndMe(t *testing.T) {
	dir := t.TempDir()
	if Linked(dir) {
		t.Fatal("empty folder is not linked")
	}
	name := "ana"
	_ = os.WriteFile(filepath.Join(dir, SessionFile), []byte("{}"), 0o600)
	if err := writeMe(dir, Me{UserID: 1, Phone: "33", Name: "Ana", Username: &name}); err != nil {
		t.Fatal(err)
	}
	if !Linked(dir) {
		t.Fatal("should be linked")
	}
	if st, _ := os.Stat(filepath.Join(dir, MeFile)); st.Mode().Perm() != 0o600 {
		t.Fatalf("me.json mode %v", st.Mode())
	}
	me, err := ReadMe(dir)
	if err != nil || me.Name != "Ana" || *me.Username != "ana" {
		t.Fatalf("ReadMe %+v %v", me, err)
	}
	if _, err := loadSession(t.TempDir()); !errors.Is(err, ErrNotLinked) {
		t.Fatalf("no session: %v", err)
	}
}

func TestConvertMessages(t *testing.T) {
	p := newPeers()
	p.add(
		[]tg.UserClass{&tg.User{ID: 42, AccessHash: 9, FirstName: "Ana", LastName: "M", Username: "anam", Phone: "336"}, &tg.User{ID: 1, Self: true, FirstName: "Me"}},
		[]tg.ChatClass{&tg.Chat{ID: 5, Title: "School"}, &tg.Channel{ID: 77, AccessHash: 3, Title: "Twins", Megagroup: true}},
	)
	me := Me{UserID: 1, Name: "Me"}
	msg := &tg.Message{ID: 3, PeerID: &tg.PeerChannel{ChannelID: 77}, FromID: &tg.PeerUser{UserID: 42}, Date: 60, Message: "hi"}
	msg.SetFlags()
	m, chat, ok := p.messageOf(msg, me)
	if !ok || m.ChatID != "-1000000000077" || chat.Type != "group" || m.FromID != "42" || m.FromName != "Ana M" || m.Text != "hi" {
		t.Fatalf("channel message %+v %+v", m, chat)
	}
	// A private chat: the other side wrote it, or I did.
	in := &tg.Message{ID: 4, PeerID: &tg.PeerUser{UserID: 42}, Date: 1}
	if m, _, _ := p.messageOf(in, me); m.FromID != "42" || m.ChatName != "Ana M" {
		t.Fatalf("incoming %+v", m)
	}
	out := &tg.Message{ID: 5, Out: true, PeerID: &tg.PeerUser{UserID: 42}, Date: 1}
	if m, _, _ := p.messageOf(out, me); m.FromID != "1" || m.FromName != "Me" || !m.Out {
		t.Fatalf("outgoing %+v", m)
	}
	if _, _, ok := p.messageOf(&tg.MessageService{ID: 6}, me); ok {
		t.Fatal("service messages are skipped")
	}
	if c := p.chatOf(&tg.PeerUser{UserID: 1}); c.Name != "Saved Messages" {
		t.Fatalf("self chat %+v", c)
	}
	if peer, ok := inputPeer(chat).(*tg.InputPeerChannel); !ok || peer.ChannelID != 77 || peer.AccessHash != 3 {
		t.Fatalf("input peer %#v", inputPeer(chat))
	}
}

func TestMediaOf(t *testing.T) {
	voice := &tg.MessageMediaDocument{Document: &tg.Document{Size: 10, MimeType: "audio/ogg", Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeAudio{Voice: true}}}}
	if m := mediaOf(voice); m.Type != "voice" || m.Size != 10 {
		t.Fatalf("voice %+v", m)
	}
	file := &tg.MessageMediaDocument{Document: &tg.Document{MimeType: "application/pdf", Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: "bill.pdf"}}}}
	if m := mediaOf(file); m.Type != "document" || m.Name != "bill.pdf" {
		t.Fatalf("file %+v", m)
	}
	photo := &tg.MessageMediaPhoto{Photo: &tg.Photo{Sizes: []tg.PhotoSizeClass{&tg.PhotoSize{Type: "m", Size: 5}, &tg.PhotoSize{Type: "y", Size: 50}}}}
	if m := mediaOf(photo); m.Type != "photo" || m.Size != 50 {
		t.Fatalf("photo %+v", m)
	}
	if mediaOf(nil) != nil || mediaOf(&tg.MessageMediaWebPage{}) != nil {
		t.Fatal("no media for a link preview")
	}
}

func TestSentIDAndNames(t *testing.T) {
	if sentID(&tg.UpdateShortSentMessage{ID: 9}) != 9 {
		t.Fatal("short")
	}
	if sentID(&tg.Updates{Updates: []tg.UpdateClass{&tg.UpdateMessageID{ID: 11}}}) != 11 {
		t.Fatal("updates")
	}
	for in, want := range map[string]string{"../../etc/passwd": "passwd", "a\\b.pdf": "b.pdf", ".bashrc": "", "..": ""} {
		if got := SafeName(in); got != want {
			t.Fatalf("SafeName(%q) = %q", in, got)
		}
	}
	doc := &tg.Document{MimeType: "audio/ogg"}
	if got := documentName(doc, 3); got != "file-3.ogg" {
		t.Fatalf("documentName %s", got)
	}
	if kind, n := codeType(&tg.AuthSentCodeTypeApp{Length: 5}); kind != "app" || n != 5 {
		t.Fatalf("codeType %s %d", kind, n)
	}
}

func TestWriterSizeCap(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	w := &writer{st: st, p: newPeers(), maxDB: 1, logf: func(string, ...any) {}}
	w.p.add([]tg.UserClass{&tg.User{ID: 42, FirstName: "Ana"}}, nil)
	err = w.saveMessages([]tg.MessageClass{&tg.Message{ID: 1, PeerID: &tg.PeerUser{UserID: 42}, Date: 1, Message: "x"}})
	if err != nil || w.skipped != 1 {
		t.Fatalf("over the cap nothing is stored: %v %d", err, w.skipped)
	}
	w = &writer{st: st, p: w.p, logf: func(string, ...any) {}}
	if err := w.saveMessages([]tg.MessageClass{&tg.Message{ID: 1, PeerID: &tg.PeerUser{UserID: 42}, Date: 1, Message: "x"}}); err != nil {
		t.Fatal(err)
	}
	if c, err := st.Chat("42"); err != nil || c.Name != "Ana" {
		t.Fatalf("a chat row is added for a new chat: %+v %v", c, err)
	}
}

func TestFileKind(t *testing.T) {
	dir := t.TempDir()
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	cases := []struct {
		path, name, mime string
		photo            bool
	}{
		{write("shot.png", png), "shot.png", "image/png", true},
		{write("Unknown", png), "Unknown.png", "image/png", true},
		{write("report.pdf", []byte("%PDF-1.4")), "report.pdf", "application/pdf", false},
		{write("notes", []byte("hello")), "notes", "text/plain", false},
		{write("anim.gif", []byte("GIF89a")), "anim.gif", "image/gif", false},
	}
	for _, c := range cases {
		name, mt, photo := fileKind(c.path)
		if name != c.name || mt != c.mime || photo != c.photo {
			t.Errorf("fileKind(%s) = %q %q %v, want %q %q %v", filepath.Base(c.path), name, mt, photo, c.name, c.mime, c.photo)
		}
	}
}
