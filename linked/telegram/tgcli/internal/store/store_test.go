package store

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestMarkedIDsRoundTrip(t *testing.T) {
	cases := []struct {
		kind string
		id   int64
		want string
	}{
		{KindUser, 777000, "777000"},
		{KindChat, 123, "-123"},
		{KindChannel, 1234567890, "-1001234567890"},
	}
	for _, c := range cases {
		got := MarkedID(c.kind, c.id)
		if got != c.want {
			t.Fatalf("MarkedID(%s, %d) = %s, want %s", c.kind, c.id, got, c.want)
		}
		kind, id, err := ParseMarkedID(got)
		if err != nil || kind != c.kind || id != c.id {
			t.Fatalf("ParseMarkedID(%s) = %s %d %v", got, kind, id, err)
		}
	}
	for _, bad := range []string{"", "0", "abc", "@x"} {
		if _, _, err := ParseMarkedID(bad); err == nil {
			t.Fatalf("ParseMarkedID(%q) should fail", bad)
		}
	}
}

func TestChatType(t *testing.T) {
	if ChatType(KindUser, false) != "user" || ChatType(KindChat, false) != "group" ||
		ChatType(KindChannel, true) != "group" || ChatType(KindChannel, false) != "channel" {
		t.Fatal("wrong chat types")
	}
}

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "store.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func strp(s string) *string { return &s }

func seed(t *testing.T, s *Store) {
	t.Helper()
	chats := []Chat{
		{ID: "42", Kind: KindUser, RawID: 42, AccessHash: 9, Name: "Ana Martin", Type: "user", Username: strp("anam"), Phone: "+33 6 39 98 12 34"},
		{ID: "-5", Kind: KindChat, RawID: 5, Name: "School parents", Type: "group"},
		{ID: "-1000000000077", Kind: KindChannel, RawID: 77, AccessHash: 3, Name: "Twins", Type: "group"},
		{ID: "-1000000000078", Kind: KindChannel, RawID: 78, AccessHash: 4, Name: "Twins", Type: "channel"},
	}
	for _, c := range chats {
		if err := s.UpsertChat(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.UpsertUser(User{ID: 42, AccessHash: 9, Name: "Ana Martin", Username: "anam", Phone: "33639981234", Contact: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertUser(User{ID: 43, AccessHash: 8, Name: "Bob", Username: "bobby", Phone: "447700900123"}); err != nil {
		t.Fatal(err)
	}
	msgs := []Message{
		{ChatID: "-5", ID: 1, FromID: "42", FromName: "Ana Martin", Unix: 100, Text: "La réunion de l'école est jeudi"},
		{ChatID: "-5", ID: 2, FromID: "43", FromName: "Bob", Unix: 200, Text: "Merci, see you Thursday", ReplyTo: 1},
		{ChatID: "42", ID: 10, Out: true, Unix: 300, Text: "photo", Media: &Media{Type: "photo", Name: "photo.jpg", Size: 1234, Mime: "image/jpeg"}},
	}
	for _, m := range msgs {
		if err := s.UpsertMessage(m); err != nil {
			t.Fatal(err)
		}
	}
}

func TestResolve(t *testing.T) {
	s := open(t)
	seed(t, s)
	cases := map[string]string{
		"42":                "42",
		"@AnaM":             "42",
		"+33 6 39 98 12 34": "42",
		"school parents":    "-5",
		"-5":                "-5",
		"@bobby":            "43", // a known user without a dialog
		"+447700900123":     "43",
		"43":                "43",
	}
	for ref, want := range cases {
		c, err := s.Resolve(ref)
		if err != nil || c.ID != want {
			t.Fatalf("Resolve(%q) = %q, %v; want %q", ref, c.ID, err, want)
		}
	}
	if c, _ := s.Resolve("@bobby"); c.AccessHash != 8 || c.Kind != KindUser {
		t.Fatalf("user chat lacks its access hash: %+v", c)
	}
	for _, ref := range []string{"@nobody", "+111111111", "Nobody", "-99", ""} {
		if _, err := s.Resolve(ref); err == nil {
			t.Fatalf("Resolve(%q) should fail", ref)
		}
	}
	if _, err := s.Resolve("Twins"); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("an ambiguous name must say so, got %v", err)
	}
}

func TestMessagesAndSearch(t *testing.T) {
	s := open(t)
	seed(t, s)
	msgs, err := s.Messages("-5", 10, 0)
	if err != nil || len(msgs) != 2 || msgs[0].ID != 1 || msgs[1].ReplyTo != 1 || msgs[0].ChatName != "School parents" {
		t.Fatalf("Messages = %+v, %v", msgs, err)
	}
	if msgs, _ := s.Messages("-5", 10, 2); len(msgs) != 1 || msgs[0].ID != 1 {
		t.Fatalf("before 2 = %+v", msgs)
	}
	// Accents are folded; every word must match.
	hits, err := s.Search("ecole jeudi", "", 10)
	if err != nil || len(hits) != 1 || hits[0].ID != 1 {
		t.Fatalf("Search = %+v, %v", hits, err)
	}
	if hits, _ := s.Search("thursday", "42", 10); len(hits) != 0 {
		t.Fatalf("chat filter ignored: %+v", hits)
	}
	// FTS syntax in the query is just text.
	if _, err := s.Search(`"AND OR NEAR(`, "", 10); err != nil {
		t.Fatalf("quoted query failed: %v", err)
	}
	// An edit replaces the indexed text.
	if err := s.UpsertMessage(Message{ChatID: "-5", ID: 1, Unix: 100, Text: "Moved to Friday"}); err != nil {
		t.Fatal(err)
	}
	if hits, _ := s.Search("jeudi", "", 10); len(hits) != 0 {
		t.Fatalf("old text still indexed: %+v", hits)
	}
	if hits, _ := s.Search("friday", "", 10); len(hits) != 1 {
		t.Fatalf("new text not indexed: %+v", hits)
	}
	m, err := s.Message("42", 10)
	if err != nil || m.Media == nil || m.Media.Type != "photo" || !m.Out || m.Date != "1970-01-01T00:05:00Z" {
		t.Fatalf("Message = %+v, %v", m, err)
	}
	if _, err := s.Message("42", 99); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing message: %v", err)
	}
}

func TestChatsListAndLastMessage(t *testing.T) {
	s := open(t)
	seed(t, s)
	chats, err := s.Chats("", 10)
	if err != nil || len(chats) != 4 || chats[0].ID != "42" || chats[0].LastMessageAt == "" {
		t.Fatalf("Chats = %+v, %v", chats, err)
	}
	if chats, _ := s.Chats("parent", 10); len(chats) != 1 || chats[0].ID != "-5" {
		t.Fatalf("query = %+v", chats)
	}
	if id, _ := s.LastMessageID("-5"); id != 2 {
		t.Fatalf("LastMessageID = %d", id)
	}
	// Re-upserting a chat with an older time keeps the newer one, and an empty hash keeps the old.
	if err := s.UpsertChat(Chat{ID: "42", Kind: KindUser, RawID: 42, Name: "Ana", Type: "user"}); err != nil {
		t.Fatal(err)
	}
	c, _ := s.Chat("42")
	if c.AccessHash != 9 || c.LastMessageAt == "" || c.Name != "Ana" {
		t.Fatalf("upsert lost data: %+v", c)
	}
	if size, err := s.Size(); err != nil || size <= 0 {
		t.Fatalf("Size = %d, %v", size, err)
	}
}

func TestFTSQuery(t *testing.T) {
	if got := FTSQuery(` hello  "wo"rld `); got != `"hello" """wo""rld"` {
		t.Fatalf("FTSQuery = %s", got)
	}
	if FTSQuery("   ") != "" {
		t.Fatal("blank query")
	}
}
