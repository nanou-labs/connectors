// Package tgc is tgcli's side of Telegram (MTProto through gotd/td): app
// credentials, the linked-device session, linking, the sync, and the few
// writes (send, media download, logging this device out).
//
// The session file belongs to `sync`, which keeps it current. Every other
// command that talks to Telegram loads it into memory and never writes it
// back, so two processes can't tear it.
package tgc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// Files in an account's folder.
const (
	SessionFile = "session.json"
	MeFile      = "me.json"
	StoreFile   = "store.db"
	LockFile    = "sync.lock"
)

// App is nanou's Telegram application (my.telegram.org): every connection names it.
type App struct {
	ID   int
	Hash string
}

// ErrNoApp is returned when no app credentials are configured.
var ErrNoApp = errors.New("no Telegram app credentials: set TGCLI_API_ID and TGCLI_API_HASH or write ~/.config/tgcli/app.json")

// LoadApp reads the app credentials from TGCLI_API_ID/TGCLI_API_HASH, else
// from <home>/.config/tgcli/app.json ({"api_id": 123, "api_hash": "…"}).
func LoadApp(home string) (App, error) {
	if id, hash := os.Getenv("TGCLI_API_ID"), os.Getenv("TGCLI_API_HASH"); id != "" && hash != "" {
		n, err := strconv.Atoi(strings.TrimSpace(id))
		if err != nil || n <= 0 {
			return App{}, errors.New("TGCLI_API_ID is not a number")
		}
		return App{ID: n, Hash: strings.TrimSpace(hash)}, nil
	}
	raw, err := os.ReadFile(filepath.Join(home, ".config", "tgcli", "app.json"))
	if err != nil {
		return App{}, ErrNoApp
	}
	var f struct {
		ID   json.Number `json:"api_id"`
		Hash string      `json:"api_hash"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return App{}, errors.New("~/.config/tgcli/app.json is not valid JSON")
	}
	n, err := strconv.Atoi(f.ID.String())
	if err != nil || n <= 0 || f.Hash == "" {
		return App{}, ErrNoApp
	}
	return App{ID: n, Hash: f.Hash}, nil
}

// Me is who the account is, saved at link time (me.json): `auth status` reads it offline.
type Me struct {
	UserID   int64   `json:"user_id"`
	Phone    string  `json:"phone"`
	Name     string  `json:"name"`
	Username *string `json:"username"`
}

// MeFrom builds Me from Telegram's user.
func MeFrom(u *tg.User) Me {
	me := Me{UserID: u.ID, Phone: u.Phone, Name: FullName(u.FirstName, u.LastName)}
	if u.Username != "" {
		name := u.Username
		me.Username = &name
	}
	return me
}

// ReadMe reads an account's me.json.
func ReadMe(dir string) (Me, error) {
	var me Me
	raw, err := os.ReadFile(filepath.Join(dir, MeFile))
	if err != nil {
		return me, err
	}
	return me, json.Unmarshal(raw, &me)
}

// writePrivate writes a file only the family's user can read, atomically.
func writePrivate(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func writeMe(dir string, me Me) error {
	raw, err := json.Marshal(me)
	if err != nil {
		return err
	}
	return writePrivate(filepath.Join(dir, MeFile), raw)
}

// Linked reports whether an account has a session and knows who it is.
func Linked(dir string) bool {
	for _, f := range []string{SessionFile, MeFile} {
		if st, err := os.Stat(filepath.Join(dir, f)); err != nil || st.Size() == 0 {
			return false
		}
	}
	return true
}

// FullName joins a first and last name.
func FullName(first, last string) string {
	return strings.TrimSpace(first + " " + last)
}

// ErrNotLinked is returned when an account has no session yet.
var ErrNotLinked = errors.New("this Telegram account is not linked (run tgcli auth)")

// loadSession reads the session file into memory (never written back).
func loadSession(dir string) (*session.StorageMemory, error) {
	raw, err := os.ReadFile(filepath.Join(dir, SessionFile))
	if err != nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil, ErrNotLinked
	}
	mem := &session.StorageMemory{}
	if err := mem.StoreSession(context.Background(), raw); err != nil {
		return nil, err
	}
	return mem, nil
}

// FloodError is a FLOOD_WAIT longer than tgcli is willing to wait.
type FloodError struct{ Seconds int }

func (e *FloodError) Error() string {
	return fmt.Sprintf("Telegram asks to wait %d s before trying again (FLOOD_WAIT)", e.Seconds)
}

// floodWait retries a call Telegram rate-limited, sleeping what it asks,
// when that is at most maxWait; a longer wait comes back as a FloodError.
func floodWait(maxWait time.Duration) telegram.Middleware {
	return telegram.MiddlewareFunc(func(next tg.Invoker) telegram.InvokeFunc {
		return func(ctx context.Context, input bin.Encoder, output bin.Decoder) error {
			for attempt := 0; ; attempt++ {
				err := next.Invoke(ctx, input, output)
				d, ok := tgerr.AsFloodWait(err)
				if !ok {
					return err
				}
				if d > maxWait || attempt >= 3 {
					return &FloodError{Seconds: int(d / time.Second)}
				}
				t := time.NewTimer(d + time.Second)
				select {
				case <-ctx.Done():
					t.Stop()
					return ctx.Err()
				case <-t.C:
				}
			}
		}
	})
}

// newClient is a Telegram client that shows up as "nanou" in the person's
// Devices list and logs nothing.
func newClient(app App, storage telegram.SessionStorage, version string, handler telegram.UpdateHandler, maxWait time.Duration) *telegram.Client {
	if version == "" {
		version = "dev"
	}
	return telegram.NewClient(app.ID, app.Hash, telegram.Options{
		SessionStorage: storage,
		UpdateHandler:  handler,
		NoUpdates:      handler == nil,
		Middlewares:    []telegram.Middleware{floodWait(maxWait)},
		Device: telegram.DeviceConfig{
			DeviceModel:    "nanou",
			SystemVersion:  "Linux",
			AppVersion:     version,
			SystemLangCode: "en",
			LangCode:       "en",
		},
	})
}

// stayOffline tells Telegram this session is offline, so the person's own
// apps keep their notifications.
func stayOffline(ctx context.Context, api *tg.Client) {
	_, _ = api.AccountUpdateStatus(ctx, true)
}

// oneShot runs f on a client built from the saved session (in memory only).
func oneShot(ctx context.Context, app App, dir, version string, f func(ctx context.Context, api *tg.Client) error) error {
	mem, err := loadSession(dir)
	if err != nil {
		return err
	}
	client := newClient(app, mem, version, nil, 60*time.Second)
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
		return f(ctx, api)
	})
}
