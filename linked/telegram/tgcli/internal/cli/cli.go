package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nanou-labs/connectors/linked/telegram/tgcli/internal/lock"
	"github.com/nanou-labs/connectors/linked/telegram/tgcli/internal/store"
	"github.com/nanou-labs/connectors/linked/telegram/tgcli/internal/tgc"
)

// ErrReadOnly is what every write says while read-only is on.
var ErrReadOnly = errors.New("tgcli is read-only (TGCLI_READONLY=1)")

// Env is what a run reads and writes besides its arguments.
type Env struct {
	Ctx     context.Context
	Stdin   io.Reader
	Stdout  io.Writer
	Stderr  io.Writer
	Home    string
	Version string
}

const usage = `tgcli: Telegram as a linked device, for nanou.

Usage: tgcli [--account NAME] [--read-only] [--json] [--store DIR] COMMAND

  accounts list                         accounts in the store
  accounts remove NAME                  delete an account's local folder (after auth logout)
  auth (--qr | --phone +33…) [--events] link this device (code / password read from stdin)
  auth status                           whether the account is linked (offline)
  auth logout                           log this device out (this session only)
  sync [--follow] [--chats N] [--history N] [--max-db-size 2GB]
  chats list [--query Q] [--limit N]
  chats show --chat X
  messages list --chat X [--limit N] [--before ID]
  messages search QUERY [--chat X] [--limit N]
  messages show --chat X --id N
  media download --chat X --id N [--output PATH]
  send text --to X --message TEXT [--reply-to N]
  send file --to X --file PATH [--caption TEXT]

X is a chat id (as chats list prints it), @username, +phone of a contact, or a chat's exact name.
Read-only (--read-only or TGCLI_READONLY=1) refuses auth, logout, sync, media download and send.
`

// Main runs tgcli and returns its exit code.
func Main(argv []string, env Env) int {
	a, err := Parse(argv)
	out := Output{JSON: a.JSON, Stdout: env.Stdout, Stderr: env.Stderr}
	if err != nil {
		return out.Fail(err)
	}
	if a.Version {
		fmt.Fprintf(env.Stdout, "tgcli %s\n", env.Version)
		return 0
	}
	if a.Help || len(a.Words) == 0 {
		fmt.Fprint(env.Stderr, usage)
		if a.Help {
			return 0
		}
		return 2
	}
	r := &run{a: a, env: env, out: out}
	if err := r.dispatch(); err != nil {
		return out.Fail(err)
	}
	return r.code
}

type run struct {
	a    Args
	env  Env
	out  Output
	code int
}

func (r *run) storeRoot() string {
	if r.a.Store != "" {
		return r.a.Store
	}
	return filepath.Join(r.env.Home, ".local", "state", "tgcli")
}

func (r *run) dir() string { return filepath.Join(r.storeRoot(), r.a.Account) }

func (r *run) words(n int) string { return strings.Join(r.a.Words[:min(n, len(r.a.Words))], " ") }

func (r *run) dispatch() error {
	w := r.a.Words
	cmd := w[0]
	sub := ""
	if len(w) > 1 {
		sub = w[1]
	}
	switch {
	case cmd == "accounts" && sub == "list":
		return r.accountsList()
	case cmd == "accounts" && sub == "remove":
		return r.accountsRemove()
	case cmd == "auth" && sub == "status":
		return r.authStatus()
	case cmd == "auth" && sub == "logout":
		return r.authLogout()
	case cmd == "auth" && sub == "":
		return r.auth()
	case cmd == "sync" && sub == "":
		return r.sync()
	case cmd == "chats" && sub == "list":
		return r.chatsList()
	case cmd == "chats" && sub == "show":
		return r.chatsShow()
	case cmd == "messages" && sub == "list":
		return r.messagesList()
	case cmd == "messages" && sub == "search":
		return r.messagesSearch()
	case cmd == "messages" && sub == "show":
		return r.messagesShow()
	case cmd == "media" && sub == "download":
		return r.mediaDownload()
	case cmd == "send" && (sub == "text" || sub == "file"):
		return r.send(sub)
	}
	return fmt.Errorf("unknown command %q (tgcli --help)", r.words(2))
}

// writable refuses a write while read-only is on.
func (r *run) writable() error {
	if r.a.IsReadOnly() {
		return ErrReadOnly
	}
	return nil
}

// openStore opens the account's store; for reads, a missing store is an error (nothing synced yet).
func (r *run) openStore(create bool) (*store.Store, error) {
	path := filepath.Join(r.dir(), tgc.StoreFile)
	if !create {
		if _, err := os.Stat(path); err != nil {
			return nil, fmt.Errorf("nothing synced yet for account %q", r.a.Account)
		}
	} else if err := os.MkdirAll(r.dir(), 0o700); err != nil {
		return nil, err
	}
	return store.Open(path)
}

// --- accounts ----------------------------------------------------------------

func (r *run) accountsList() error {
	if err := r.a.Check(); err != nil {
		return err
	}
	type row struct {
		Name   string `json:"name"`
		Linked bool   `json:"linked"`
	}
	rows := []row{}
	entries, err := os.ReadDir(r.storeRoot())
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, e := range entries {
		if e.IsDir() && ValidAccount(e.Name()) {
			rows = append(rows, row{Name: e.Name(), Linked: tgc.Linked(filepath.Join(r.storeRoot(), e.Name()))})
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
	r.out.OK(map[string]any{"accounts": rows}, func(w io.Writer) {
		for _, x := range rows {
			state := "not linked"
			if x.Linked {
				state = "linked"
			}
			fmt.Fprintf(w, "%s\t%s\n", x.Name, state)
		}
	})
	return nil
}

func (r *run) accountsRemove() error {
	if err := r.a.Check(); err != nil {
		return err
	}
	if err := r.writable(); err != nil {
		return err
	}
	if len(r.a.Words) != 3 || !ValidAccount(r.a.Words[2]) {
		return errors.New("usage: tgcli accounts remove NAME")
	}
	dir := filepath.Join(r.storeRoot(), r.a.Words[2])
	if _, err := os.Stat(dir); err != nil {
		return fmt.Errorf("no account %q", r.a.Words[2])
	}
	l, err := lock.Acquire(filepath.Join(dir, tgc.LockFile), r.a.LockWait)
	if err != nil {
		return err
	}
	defer l.Release()
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	r.out.OK(map[string]any{}, func(w io.Writer) { fmt.Fprintf(w, "removed %s\n", r.a.Words[2]) })
	return nil
}

// --- auth --------------------------------------------------------------------

func (r *run) authStatus() error {
	if err := r.a.Check(); err != nil {
		return err
	}
	data := map[string]any{"authenticated": false}
	if tgc.Linked(r.dir()) {
		if me, err := tgc.ReadMe(r.dir()); err == nil {
			data = map[string]any{
				"authenticated": true, "phone": me.Phone, "name": me.Name,
				"username": me.Username, "user_id": me.UserID,
			}
		}
	}
	r.out.OK(data, func(w io.Writer) {
		if data["authenticated"] == true {
			fmt.Fprintf(w, "linked: %s (+%s)\n", data["name"], data["phone"])
		} else {
			fmt.Fprintln(w, "not linked")
		}
	})
	return nil
}

func (r *run) authLogout() error {
	if err := r.a.Check(); err != nil {
		return err
	}
	if err := r.writable(); err != nil {
		return err
	}
	app, err := tgc.LoadApp(r.env.Home)
	if err != nil && tgc.Linked(r.dir()) {
		return err
	}
	if err := tgc.Logout(r.env.Ctx, app, r.dir(), r.env.Version); err != nil {
		return err
	}
	r.out.OK(map[string]any{}, func(w io.Writer) { fmt.Fprintln(w, "logged out") })
	return nil
}

// phonePattern is an international number as typed: + then 7 to 15 digits (spaces allowed).
var phonePattern = regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`)

// NormalizePhone checks a number for `auth --phone` and drops what isn't a digit after the +.
func NormalizePhone(raw string) (string, error) {
	p := "+" + store.Digits(raw)
	if !strings.HasPrefix(strings.TrimSpace(raw), "+") || !phonePattern.MatchString(p) {
		return "", errors.New("--phone needs an international number, e.g. +33639981234")
	}
	return p, nil
}

// humanEvents shows auth's progress to a person at a terminal.
type humanEvents struct{ w io.Writer }

func (h humanEvents) Emit(name string, data map[string]any) {
	switch name {
	case "qr_code":
		fmt.Fprintf(h.w, "Scan in Telegram → Settings → Devices → Link Desktop Device:\n%s\n", data["url"])
	case "code_sent":
		fmt.Fprintf(h.w, "Telegram sent a code (%s). Type it: ", data["type"])
	case "code_invalid":
		fmt.Fprint(h.w, "That code isn't right. Type it again: ")
	case "password_needed":
		fmt.Fprintf(h.w, "Two-step verification password (hint: %s): ", data["hint"])
	case "password_invalid":
		fmt.Fprint(h.w, "Wrong password. Try again: ")
	case "connected":
		fmt.Fprintf(h.w, "\nLinked as %s.\n", data["name"])
	case "error":
		fmt.Fprintf(h.w, "\nerror (%s): %s\n", data["kind"], data["message"])
	}
}

func (r *run) auth() error {
	if err := r.a.Check("qr", "phone"); err != nil {
		return err
	}
	if err := r.writable(); err != nil {
		return err
	}
	var em tgc.Emitter = &Events{W: r.env.Stderr, On: true}
	if !r.a.Events {
		em = humanEvents{w: r.env.Stderr}
	}
	fail := func(err error) error {
		kind, secs := tgc.ErrorKind(err)
		data := map[string]any{"kind": kind, "message": err.Error()}
		if secs > 0 {
			data["seconds"] = secs
		}
		em.Emit("error", data)
		return err
	}
	phone := ""
	if raw, ok := r.a.Flags["phone"]; ok {
		if r.a.Flags["qr"] == "true" {
			return errors.New("use --qr or --phone, not both")
		}
		p, err := NormalizePhone(raw)
		if err != nil {
			return fail(err)
		}
		phone = p
	}
	app, err := tgc.LoadApp(r.env.Home)
	if err != nil {
		return fail(err)
	}
	if err := os.MkdirAll(r.dir(), 0o700); err != nil {
		return err
	}
	l, err := lock.Acquire(filepath.Join(r.dir(), tgc.LockFile), r.a.LockWait)
	if err != nil {
		return fail(err)
	}
	defer l.Release()
	inputs := ReadInputs(r.env.Stdin, r.a.Events)
	answers := make(chan tgc.Input)
	go func() {
		defer close(answers)
		for in := range inputs {
			answers <- tgc.Input{Code: in.Code, Password: in.Password}
		}
	}()
	err = tgc.Auth(r.env.Ctx, tgc.AuthOptions{
		App: app, Dir: r.dir(), Version: r.env.Version, Phone: phone, Events: em, Inputs: answers,
	})
	if err != nil {
		return fail(err)
	}
	me, _ := tgc.ReadMe(r.dir())
	r.out.OK(me, func(io.Writer) {})
	return nil
}

// --- sync --------------------------------------------------------------------

// ParseSize reads a size like 2GB, 500MB or a byte count.
func ParseSize(s string) (int64, error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	mult := int64(1)
	for _, u := range []struct {
		suffix string
		n      int64
	}{{"GB", 1 << 30}, {"MB", 1 << 20}, {"KB", 1 << 10}, {"B", 1}} {
		if strings.HasSuffix(s, u.suffix) {
			s, mult = strings.TrimSpace(strings.TrimSuffix(s, u.suffix)), u.n
			break
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0, errors.New("bad size (e.g. 2GB, 500MB)")
	}
	return n * mult, nil
}

func (r *run) sync() error {
	if err := r.a.Check("follow", "chats", "history", "max-db-size"); err != nil {
		return err
	}
	if err := r.writable(); err != nil {
		return err
	}
	if !tgc.Linked(r.dir()) {
		return tgc.ErrNotLinked
	}
	chats, err := r.a.Int("chats", 200)
	if err != nil {
		return err
	}
	hist, err := r.a.Int("history", 50)
	if err != nil {
		return err
	}
	maxDB := int64(2 << 30)
	if v, ok := r.a.Flags["max-db-size"]; ok {
		if maxDB, err = ParseSize(v); err != nil {
			return err
		}
	}
	app, err := tgc.LoadApp(r.env.Home)
	if err != nil {
		return err
	}
	l, err := lock.Acquire(filepath.Join(r.dir(), tgc.LockFile), r.a.LockWait)
	if err != nil {
		return err
	}
	defer l.Release()
	st, err := r.openStore(true)
	if err != nil {
		return err
	}
	defer st.Close()
	logf := func(format string, args ...any) {
		fmt.Fprintf(r.env.Stderr, "%s %s\n", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
	}
	err = tgc.Sync(r.env.Ctx, tgc.SyncOptions{
		App: app, Dir: r.dir(), Version: r.env.Version, Store: st, Follow: r.a.Flags["follow"] == "true",
		Chats: chats, History: hist, MaxDB: maxDB, Logf: logf,
	})
	if errors.Is(err, context.Canceled) {
		err = nil // stopped (SIGTERM, timeout): a normal end
	}
	if err != nil {
		return err
	}
	r.out.OK(map[string]any{}, func(io.Writer) {})
	return nil
}

// --- reads (offline, from the store) ----------------------------------------

func (r *run) chatsList() error {
	if err := r.a.Check("query", "limit"); err != nil {
		return err
	}
	limit, err := r.a.Int("limit", 50)
	if err != nil {
		return err
	}
	chats := []store.Chat{}
	if st, err := r.openStore(false); err == nil {
		defer st.Close()
		if chats, err = st.Chats(r.a.Flags["query"], limit); err != nil {
			return err
		}
	}
	r.out.OK(chats, func(w io.Writer) {
		for _, c := range chats {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", c.ID, c.Type, c.Name, c.LastMessageAt)
		}
	})
	return nil
}

// chatFlag resolves the --chat (or --to) flag against the store.
func chatFlag(st *store.Store, a Args, name string) (store.Chat, error) {
	ref, ok := a.Flags[name]
	if !ok || strings.TrimSpace(ref) == "" {
		return store.Chat{}, fmt.Errorf("--%s is required", name)
	}
	return st.Resolve(ref)
}

func (r *run) chatsShow() error {
	if err := r.a.Check("chat"); err != nil {
		return err
	}
	st, err := r.openStore(false)
	if err != nil {
		return err
	}
	defer st.Close()
	c, err := chatFlag(st, r.a, "chat")
	if err != nil {
		return err
	}
	r.out.OK(c, func(w io.Writer) { fmt.Fprintf(w, "%s\t%s\t%s\n", c.ID, c.Type, c.Name) })
	return nil
}

func printMessages(w io.Writer, msgs []store.Message) {
	for _, m := range msgs {
		who := m.FromName
		if m.Out {
			who = "me"
		}
		text := m.Text
		if m.Media != nil {
			text = strings.TrimSpace(fmt.Sprintf("[%s %s] %s", m.Media.Type, m.Media.Name, text))
		}
		fmt.Fprintf(w, "%s  #%d  %s: %s\n", m.Date, m.ID, who, text)
	}
}

func (r *run) messagesList() error {
	if err := r.a.Check("chat", "limit", "before"); err != nil {
		return err
	}
	limit, err := r.a.Int("limit", 50)
	if err != nil {
		return err
	}
	before, err := r.a.Int("before", 0)
	if err != nil {
		return err
	}
	st, err := r.openStore(false)
	if err != nil {
		return err
	}
	defer st.Close()
	c, err := chatFlag(st, r.a, "chat")
	if err != nil {
		return err
	}
	msgs, err := st.Messages(c.ID, limit, before)
	if err != nil {
		return err
	}
	r.out.OK(msgs, func(w io.Writer) { printMessages(w, msgs) })
	return nil
}

func (r *run) messagesSearch() error {
	if err := r.a.Check("chat", "limit", "query"); err != nil {
		return err
	}
	query := strings.Join(r.a.Words[2:], " ")
	if q, ok := r.a.Flags["query"]; ok {
		query = strings.TrimSpace(query + " " + q)
	}
	limit, err := r.a.Int("limit", 20)
	if err != nil {
		return err
	}
	st, err := r.openStore(false)
	if err != nil {
		return err
	}
	defer st.Close()
	chatID := ""
	if _, ok := r.a.Flags["chat"]; ok {
		c, err := chatFlag(st, r.a, "chat")
		if err != nil {
			return err
		}
		chatID = c.ID
	}
	msgs, err := st.Search(query, chatID, limit)
	if err != nil {
		return err
	}
	r.out.OK(msgs, func(w io.Writer) { printMessages(w, msgs) })
	return nil
}

func (r *run) messagesShow() error {
	if err := r.a.Check("chat", "id"); err != nil {
		return err
	}
	id, err := r.a.Int("id", 0)
	if err != nil || id <= 0 {
		return errors.New("--id is required (a message id)")
	}
	st, err := r.openStore(false)
	if err != nil {
		return err
	}
	defer st.Close()
	c, err := chatFlag(st, r.a, "chat")
	if err != nil {
		return err
	}
	m, err := st.Message(c.ID, id)
	if err != nil {
		return fmt.Errorf("message %d: %w", id, err)
	}
	r.out.OK(m, func(w io.Writer) { printMessages(w, []store.Message{m}) })
	return nil
}

// --- writes ------------------------------------------------------------------

func (r *run) mediaDownload() error {
	if err := r.a.Check("chat", "id", "output"); err != nil {
		return err
	}
	if err := r.writable(); err != nil {
		return err
	}
	id, err := r.a.Int("id", 0)
	if err != nil || id <= 0 {
		return errors.New("--id is required (a message id)")
	}
	app, err := tgc.LoadApp(r.env.Home)
	if err != nil {
		return err
	}
	st, err := r.openStore(false)
	if err != nil {
		return err
	}
	defer st.Close()
	c, err := chatFlag(st, r.a, "chat")
	if err != nil {
		return err
	}
	path, size, err := tgc.Download(r.env.Ctx, tgc.DownloadOptions{
		App: app, Dir: r.dir(), Version: r.env.Version, Chat: c, ID: id, Output: r.a.Flags["output"],
	})
	if err != nil {
		return err
	}
	r.out.OK(map[string]any{"path": path, "size": size}, func(w io.Writer) { fmt.Fprintf(w, "%s (%d bytes)\n", path, size) })
	return nil
}

func (r *run) send(kind string) error {
	allowed := []string{"to", "message", "reply-to"}
	if kind == "file" {
		allowed = []string{"to", "file", "caption", "reply-to"}
	}
	if err := r.a.Check(allowed...); err != nil {
		return err
	}
	if err := r.writable(); err != nil {
		return err
	}
	reply, err := r.a.Int("reply-to", 0)
	if err != nil {
		return err
	}
	o := tgc.SendOptions{Dir: r.dir(), Version: r.env.Version, ReplyTo: reply}
	if kind == "text" {
		o.Text = r.a.Flags["message"]
		if strings.TrimSpace(o.Text) == "" {
			return errors.New("--message is required")
		}
	} else {
		o.File, o.Text = r.a.Flags["file"], r.a.Flags["caption"]
		info, err := os.Stat(o.File)
		if o.File == "" || err != nil || !info.Mode().IsRegular() {
			return errors.New("--file must be an existing file")
		}
	}
	ref := strings.TrimSpace(r.a.Flags["to"])
	if ref == "" {
		return errors.New("--to is required")
	}
	if o.App, err = tgc.LoadApp(r.env.Home); err != nil {
		return err
	}
	if !tgc.Linked(r.dir()) {
		return tgc.ErrNotLinked
	}
	st, err := r.openStore(true)
	if err != nil {
		return err
	}
	defer st.Close()
	o.Store = st
	c, err := st.Resolve(ref)
	switch {
	case err == nil:
		o.To = tgc.Target{Ref: ref, Chat: c, Ok: true}
	case errors.Is(err, store.ErrNotFound) && strings.HasPrefix(ref, "@"):
		o.To = tgc.Target{Ref: ref}
	default:
		return err
	}
	m, err := tgc.Send(r.env.Ctx, o)
	if err != nil {
		return err
	}
	r.out.OK(map[string]any{"id": m.ID, "chat_id": m.ChatID}, func(w io.Writer) {
		fmt.Fprintf(w, "sent #%d to %s\n", m.ID, m.ChatName)
	})
	return nil
}
