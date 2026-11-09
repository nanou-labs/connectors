package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite" // the pure-Go SQLite driver, with FTS5
)

// ErrNotFound is returned when a chat or message isn't in the store.
var ErrNotFound = errors.New("not found")

// Chat is one conversation: a person, a group or a channel.
type Chat struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Type          string  `json:"type"`
	Username      *string `json:"username"`
	LastMessageAt string  `json:"last_message_at,omitempty"`
	Unread        int     `json:"unread"`

	Kind       string `json:"-"` // KindUser | KindChat | KindChannel
	RawID      int64  `json:"-"`
	AccessHash int64  `json:"-"`
	Phone      string `json:"-"`
	lastUnix   int64
}

// User is someone seen in a chat (a sender), kept to name them and to write to them.
type User struct {
	ID         int64
	AccessHash int64
	Name       string
	Username   string
	Phone      string
	Contact    bool
}

// Media describes what a message carries besides its text.
type Media struct {
	Type string `json:"type"`
	Name string `json:"name,omitempty"`
	Size int64  `json:"size,omitempty"`
	Mime string `json:"mime,omitempty"`
}

// Message is one message as tgcli prints it.
type Message struct {
	ID       int    `json:"id"`
	ChatID   string `json:"chat_id"`
	ChatName string `json:"chat_name"`
	FromID   string `json:"from_id"`
	FromName string `json:"from_name"`
	Out      bool   `json:"out"`
	Date     string `json:"date"`
	Text     string `json:"text"`
	Media    *Media `json:"media,omitempty"`
	ReplyTo  int    `json:"reply_to,omitempty"`

	// Unix is the message's time; Date is filled from it when read.
	Unix int64 `json:"-"`
}

// Store is an open store.db.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS chats (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	raw_id INTEGER NOT NULL,
	access_hash INTEGER NOT NULL DEFAULT 0,
	name TEXT NOT NULL DEFAULT '',
	type TEXT NOT NULL,
	username TEXT,
	phone TEXT NOT NULL DEFAULT '',
	last_message_at INTEGER NOT NULL DEFAULT 0,
	unread INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chats_last ON chats(last_message_at DESC);
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY,
	access_hash INTEGER NOT NULL DEFAULT 0,
	name TEXT NOT NULL DEFAULT '',
	username TEXT NOT NULL DEFAULT '',
	phone TEXT NOT NULL DEFAULT '',
	contact INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
	chat_id TEXT NOT NULL,
	id INTEGER NOT NULL,
	from_id TEXT NOT NULL DEFAULT '',
	from_name TEXT NOT NULL DEFAULT '',
	out INTEGER NOT NULL DEFAULT 0,
	date INTEGER NOT NULL,
	text TEXT NOT NULL DEFAULT '',
	media_type TEXT NOT NULL DEFAULT '',
	media_name TEXT NOT NULL DEFAULT '',
	media_size INTEGER NOT NULL DEFAULT 0,
	media_mime TEXT NOT NULL DEFAULT '',
	reply_to INTEGER NOT NULL DEFAULT 0,
	UNIQUE (chat_id, id)
);
CREATE INDEX IF NOT EXISTS messages_date ON messages(chat_id, date);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
	text, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
	INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
	INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`

// Open opens (and creates when missing) a store, WAL with a busy timeout so
// the sync and one-shot commands can share it.
func Open(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(15000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open store: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the store.
func (s *Store) Close() error { return s.db.Close() }

// Size is the store's size in bytes.
func (s *Store) Size() (int64, error) {
	var pages, size int64
	if err := s.db.QueryRow("PRAGMA page_count").Scan(&pages); err != nil {
		return 0, err
	}
	if err := s.db.QueryRow("PRAGMA page_size").Scan(&size); err != nil {
		return 0, err
	}
	return pages * size, nil
}

// UpsertUser adds or refreshes a user. An empty access hash or name keeps the stored one.
func (s *Store) UpsertUser(u User) error {
	_, err := s.db.Exec(`INSERT INTO users(id, access_hash, name, username, phone, contact) VALUES (?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			access_hash = CASE WHEN excluded.access_hash != 0 THEN excluded.access_hash ELSE users.access_hash END,
			name = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END,
			username = excluded.username,
			phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE users.phone END,
			contact = excluded.contact`,
		u.ID, u.AccessHash, u.Name, u.Username, Digits(u.Phone), b2i(u.Contact))
	return err
}

// User reads one user.
func (s *Store) User(id int64) (User, error) {
	var u User
	var contact int
	err := s.db.QueryRow(`SELECT id, access_hash, name, username, phone, contact FROM users WHERE id = ?`, id).
		Scan(&u.ID, &u.AccessHash, &u.Name, &u.Username, &u.Phone, &contact)
	if errors.Is(err, sql.ErrNoRows) {
		return u, ErrNotFound
	}
	u.Contact = contact != 0
	return u, err
}

// UpsertChat adds or refreshes a chat; its last message time only moves forward.
func (s *Store) UpsertChat(c Chat) error {
	var username any
	if c.Username != nil && *c.Username != "" {
		username = *c.Username
	}
	_, err := s.db.Exec(`INSERT INTO chats(id, kind, raw_id, access_hash, name, type, username, phone, last_message_at, unread)
		VALUES (?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			access_hash = CASE WHEN excluded.access_hash != 0 THEN excluded.access_hash ELSE chats.access_hash END,
			name = CASE WHEN excluded.name != '' THEN excluded.name ELSE chats.name END,
			type = excluded.type,
			username = excluded.username,
			phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE chats.phone END,
			last_message_at = MAX(chats.last_message_at, excluded.last_message_at),
			unread = excluded.unread`,
		c.ID, c.Kind, c.RawID, c.AccessHash, c.Name, c.Type, username, Digits(c.Phone), c.lastUnix, c.Unread)
	return err
}

// SetLast sets a chat's last message time (unix seconds) on a chat about to be upserted.
func (c *Chat) SetLast(unix int64) { c.lastUnix = unix }

// UpsertMessage adds or replaces a message and moves its chat's last message time.
func (s *Store) UpsertMessage(m Message) error {
	var mt, mn, mm string
	var ms int64
	if m.Media != nil {
		mt, mn, ms, mm = m.Media.Type, m.Media.Name, m.Media.Size, m.Media.Mime
	}
	_, err := s.db.Exec(`INSERT INTO messages(chat_id, id, from_id, from_name, out, date, text, media_type, media_name, media_size, media_mime, reply_to)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(chat_id, id) DO UPDATE SET
			from_id = excluded.from_id, from_name = excluded.from_name, out = excluded.out, date = excluded.date,
			text = excluded.text, media_type = excluded.media_type, media_name = excluded.media_name,
			media_size = excluded.media_size, media_mime = excluded.media_mime, reply_to = excluded.reply_to`,
		m.ChatID, m.ID, m.FromID, m.FromName, b2i(m.Out), m.Unix, m.Text, mt, mn, ms, mm, m.ReplyTo)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE chats SET last_message_at = MAX(last_message_at, ?) WHERE id = ?`, m.Unix, m.ChatID)
	return err
}

// LastMessageID is the newest message id stored for a chat (0 when none).
func (s *Store) LastMessageID(chatID string) (int, error) {
	var id sql.NullInt64
	err := s.db.QueryRow(`SELECT MAX(id) FROM messages WHERE chat_id = ?`, chatID).Scan(&id)
	return int(id.Int64), err
}

const chatCols = `id, kind, raw_id, access_hash, name, type, username, phone, last_message_at, unread`

func scanChat(row interface{ Scan(...any) error }) (Chat, error) {
	var c Chat
	var username sql.NullString
	err := row.Scan(&c.ID, &c.Kind, &c.RawID, &c.AccessHash, &c.Name, &c.Type, &username, &c.Phone, &c.lastUnix, &c.Unread)
	if username.Valid {
		u := username.String
		c.Username = &u
	}
	if c.lastUnix > 0 {
		c.LastMessageAt = time.Unix(c.lastUnix, 0).UTC().Format(time.RFC3339)
	}
	return c, err
}

// Chats lists chats, most recent first, whose name or username contains query (all when empty).
func (s *Store) Chats(query string, limit int) ([]Chat, error) {
	if limit <= 0 {
		limit = 50
	}
	like := "%" + strings.ToLower(query) + "%"
	rows, err := s.db.Query(`SELECT `+chatCols+` FROM chats
		WHERE ? = '' OR lower(name) LIKE ? OR lower(COALESCE(username, '')) LIKE ?
		ORDER BY last_message_at DESC, name LIMIT ?`, query, like, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Chat{}
	for rows.Next() {
		c, err := scanChat(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Chat reads one chat by its marked id.
func (s *Store) Chat(id string) (Chat, error) {
	c, err := scanChat(s.db.QueryRow(`SELECT `+chatCols+` FROM chats WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

// userChat is a private chat built from a known user who has no dialog stored.
func userChat(u User) Chat {
	c := Chat{ID: MarkedID(KindUser, u.ID), Kind: KindUser, RawID: u.ID, AccessHash: u.AccessHash, Name: u.Name, Type: "user", Phone: u.Phone}
	if u.Username != "" {
		name := u.Username
		c.Username = &name
	}
	return c
}

// Resolve finds the chat a reference names: a marked id, @username, +phone
// (a known user's number), or an exact chat name when only one chat has it.
func (s *Store) Resolve(ref string) (Chat, error) {
	ref = strings.TrimSpace(ref)
	switch {
	case ref == "":
		return Chat{}, errors.New("no chat given")
	case strings.HasPrefix(ref, "@"):
		name := strings.ToLower(strings.TrimPrefix(ref, "@"))
		c, err := scanChat(s.db.QueryRow(`SELECT `+chatCols+` FROM chats WHERE lower(username) = ? LIMIT 1`, name))
		if err == nil {
			return c, nil
		}
		var id int64
		if err := s.db.QueryRow(`SELECT id FROM users WHERE lower(username) = ? LIMIT 1`, name).Scan(&id); err == nil {
			return s.userAsChat(id)
		}
		return Chat{}, fmt.Errorf("no chat with username %s: %w", ref, ErrNotFound)
	case strings.HasPrefix(ref, "+"):
		d := Digits(ref)
		if len(d) < 6 {
			return Chat{}, fmt.Errorf("not a phone number: %q", ref)
		}
		var id int64
		err := s.db.QueryRow(`SELECT id FROM users WHERE phone = ? LIMIT 1`, d).Scan(&id)
		if err != nil {
			return Chat{}, fmt.Errorf("no contact with number %s: %w", ref, ErrNotFound)
		}
		return s.userAsChat(id)
	}
	if kind, raw, err := ParseMarkedID(ref); err == nil {
		c, err := s.Chat(ref)
		if err == nil {
			return c, nil
		}
		if kind == KindUser {
			return s.userAsChat(raw)
		}
		return Chat{}, fmt.Errorf("no chat with id %s: %w", ref, ErrNotFound)
	}
	rows, err := s.db.Query(`SELECT `+chatCols+` FROM chats WHERE lower(name) = lower(?) LIMIT 5`, ref)
	if err != nil {
		return Chat{}, err
	}
	defer rows.Close()
	var hits []Chat
	for rows.Next() {
		c, err := scanChat(rows)
		if err != nil {
			return Chat{}, err
		}
		hits = append(hits, c)
	}
	switch len(hits) {
	case 0:
		return Chat{}, fmt.Errorf("no chat named %q: %w", ref, ErrNotFound)
	case 1:
		return hits[0], nil
	default:
		return Chat{}, fmt.Errorf("several chats are named %q: use its id (tgcli chats list --query …)", ref)
	}
}

// userAsChat is the user's private chat, stored or built from the user.
func (s *Store) userAsChat(id int64) (Chat, error) {
	if c, err := s.Chat(MarkedID(KindUser, id)); err == nil {
		return c, nil
	}
	u, err := s.User(id)
	if err != nil {
		return Chat{}, fmt.Errorf("unknown user %d: %w", id, err)
	}
	return userChat(u), nil
}

const msgCols = `m.chat_id, m.id, m.from_id, m.from_name, m.out, m.date, m.text, m.media_type, m.media_name, m.media_size, m.media_mime, m.reply_to, COALESCE(c.name, '')`

func scanMessage(row interface{ Scan(...any) error }) (Message, error) {
	var m Message
	var out int
	var mt, mn, mm string
	var ms int64
	err := row.Scan(&m.ChatID, &m.ID, &m.FromID, &m.FromName, &out, &m.Unix, &m.Text, &mt, &mn, &ms, &mm, &m.ReplyTo, &m.ChatName)
	m.Out = out != 0
	m.Date = time.Unix(m.Unix, 0).UTC().Format(time.RFC3339)
	if mt != "" {
		m.Media = &Media{Type: mt, Name: mn, Size: ms, Mime: mm}
	}
	return m, err
}

func collect(rows *sql.Rows, err error) ([]Message, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Messages lists a chat's latest messages (before a message id when before > 0), oldest first.
func (s *Store) Messages(chatID string, limit, before int) ([]Message, error) {
	if limit <= 0 {
		limit = 50
	}
	msgs, err := collect(s.db.Query(`SELECT `+msgCols+` FROM messages m LEFT JOIN chats c ON c.id = m.chat_id
		WHERE m.chat_id = ? AND (? = 0 OR m.id < ?) ORDER BY m.id DESC LIMIT ?`, chatID, before, before, limit))
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

// Message reads one message.
func (s *Store) Message(chatID string, id int) (Message, error) {
	m, err := scanMessage(s.db.QueryRow(`SELECT `+msgCols+` FROM messages m LEFT JOIN chats c ON c.id = m.chat_id
		WHERE m.chat_id = ? AND m.id = ?`, chatID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

// FTSQuery turns what someone typed into an FTS5 query: every word must
// appear, each quoted so no word is read as FTS syntax.
func FTSQuery(q string) string {
	var parts []string
	for _, w := range strings.Fields(q) {
		w = strings.ReplaceAll(w, `"`, `""`)
		parts = append(parts, `"`+w+`"`)
	}
	return strings.Join(parts, " ")
}

// Search finds messages containing every word of query, best matches first, in one chat when chatID is set.
func (s *Store) Search(query, chatID string, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 20
	}
	q := FTSQuery(query)
	if q == "" {
		return nil, errors.New("nothing to search for")
	}
	return collect(s.db.Query(`SELECT `+msgCols+` FROM messages_fts f
		JOIN messages m ON m.rowid = f.rowid LEFT JOIN chats c ON c.id = m.chat_id
		WHERE messages_fts MATCH ? AND (? = '' OR m.chat_id = ?)
		ORDER BY bm25(messages_fts), m.date DESC LIMIT ?`, q, chatID, chatID, limit))
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}
