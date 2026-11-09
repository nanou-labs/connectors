package tgc

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/auth/qrlogin"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// Emitter receives auth's events (cli.Events, or plain text for a person at a terminal).
type Emitter interface {
	Emit(name string, data map[string]any)
}

// Input is one answer for auth: the login code or the 2FA password.
type Input struct {
	Code     string
	Password string
}

// AuthOptions is one linking attempt.
type AuthOptions struct {
	App     App
	Dir     string // the account's folder
	Version string
	Phone   string // international number for a code login; empty for a QR login
	Events  Emitter
	Inputs  <-chan Input
}

// ErrUnregistered: the number has no Telegram account (tgcli never signs anyone up).
var ErrUnregistered = errors.New("this phone number has no Telegram account")

// ErrInputClosed: stdin closed while a code or password was awaited.
var ErrInputClosed = errors.New("no more input: the code or password never came")

// passwordFlood marks a FLOOD_WAIT met while checking the 2FA password.
type passwordFlood struct{ *FloodError }

// ErrorKind sorts an auth error for the provisioner: the kind, and how long to wait for a flood.
func ErrorKind(err error) (kind string, seconds int) {
	var pf passwordFlood
	var fe *FloodError
	switch {
	case errors.As(err, &pf):
		return "password_flood", pf.Seconds
	case errors.As(err, &fe):
		return "flood_wait", fe.Seconds
	case tgerr.Is(err, "PHONE_PASSWORD_FLOOD"):
		return "password_flood", 0
	case errors.Is(err, ErrNoApp):
		return "app_missing", 0
	case errors.Is(err, ErrUnregistered):
		return "phone_unregistered", 0
	case tgerr.Is(err, "PHONE_NUMBER_INVALID", "PHONE_NUMBER_UNOCCUPIED"):
		return "phone_invalid", 0
	case tgerr.Is(err, "PHONE_NUMBER_BANNED", "PHONE_NUMBER_FLOOD"):
		return "phone_banned", 0
	case tgerr.Is(err, "PHONE_CODE_EXPIRED"):
		return "code_expired", 0
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "timeout", 0
	}
	return "other", 0
}

// codeType names how Telegram sent the code.
func codeType(t tg.AuthSentCodeTypeClass) (string, int) {
	switch t := t.(type) {
	case *tg.AuthSentCodeTypeApp:
		return "app", t.Length
	case *tg.AuthSentCodeTypeSMS:
		return "sms", t.Length
	case *tg.AuthSentCodeTypeCall:
		return "call", t.Length
	case *tg.AuthSentCodeTypeFlashCall:
		return "flash_call", 0
	case *tg.AuthSentCodeTypeFragmentSMS:
		return "sms", t.Length
	}
	return "other", 0
}

// next waits for the next answer.
func next(ctx context.Context, in <-chan Input) (Input, error) {
	select {
	case <-ctx.Done():
		return Input{}, ctx.Err()
	case v, ok := <-in:
		if !ok {
			return Input{}, ErrInputClosed
		}
		return v, nil
	}
}

// Auth links the account as a new device, by QR code or by a code sent to
// the person's Telegram, then the 2FA password if the account has one. The
// session is written only once it is authorized.
func Auth(ctx context.Context, o AuthOptions) error {
	if err := os.MkdirAll(o.Dir, 0o700); err != nil {
		return err
	}
	mem := &session.StorageMemory{}
	dispatcher := tg.NewUpdateDispatcher()
	loggedIn := qrlogin.OnLoginToken(dispatcher)
	client := newClient(o.App, mem, o.Version, dispatcher, 30*time.Second)
	return client.Run(ctx, func(ctx context.Context) error {
		var authz *tg.AuthAuthorization
		var err error
		if o.Phone == "" {
			authz, err = client.QR().Auth(ctx, loggedIn, func(ctx context.Context, token qrlogin.Token) error {
				o.Events.Emit("qr_code", map[string]any{"url": token.URL(), "expires": token.Expires().Unix()})
				return nil
			})
		} else {
			authz, err = phoneLogin(ctx, client.Auth(), o)
		}
		if errors.Is(err, auth.ErrPasswordAuthNeeded) || tgerr.Is(err, "SESSION_PASSWORD_NEEDED") {
			authz, err = passwordLogin(ctx, client.API(), client.Auth(), o)
		}
		if err != nil {
			return err
		}
		user, ok := authz.User.(*tg.User)
		if !ok {
			if user, err = client.Self(ctx); err != nil {
				return err
			}
		}
		raw, err := mem.Bytes(nil)
		if err != nil {
			return err
		}
		if err := writePrivate(filepath.Join(o.Dir, SessionFile), raw); err != nil {
			return err
		}
		me := MeFrom(user)
		if err := writeMe(o.Dir, me); err != nil {
			return err
		}
		stayOffline(ctx, client.API())
		o.Events.Emit("connected", map[string]any{
			"phone": me.Phone, "name": me.Name, "username": me.Username, "user_id": me.UserID,
		})
		return nil
	})
}

// phoneLogin asks Telegram for a code and waits for it on stdin; a wrong code may be typed again.
func phoneLogin(ctx context.Context, a *auth.Client, o AuthOptions) (*tg.AuthAuthorization, error) {
	sent, err := a.SendCode(ctx, o.Phone, auth.SendCodeOptions{})
	if err != nil {
		return nil, err
	}
	var hash string
	switch s := sent.(type) {
	case *tg.AuthSentCode:
		hash = s.PhoneCodeHash
		kind, length := codeType(s.Type)
		data := map[string]any{"type": kind}
		if length > 0 {
			data["length"] = length
		}
		o.Events.Emit("code_sent", data)
	case *tg.AuthSentCodeSuccess:
		if authz, ok := s.Authorization.(*tg.AuthAuthorization); ok {
			return authz, nil
		}
		return nil, ErrUnregistered
	default:
		return nil, errors.New("unexpected answer to the code request")
	}
	for {
		in, err := next(ctx, o.Inputs)
		if err != nil {
			return nil, err
		}
		if in.Code == "" {
			continue
		}
		authz, err := a.SignIn(ctx, o.Phone, in.Code, hash)
		var signUp *auth.SignUpRequired
		switch {
		case err == nil:
			return authz, nil
		case tgerr.Is(err, "PHONE_CODE_INVALID", "PHONE_CODE_EMPTY"):
			o.Events.Emit("code_invalid", nil)
		case tgerr.Is(err, "PHONE_CODE_EXPIRED"):
			o.Events.Emit("code_expired", nil)
			return nil, err
		case errors.As(err, &signUp):
			return nil, ErrUnregistered
		default:
			return nil, err
		}
	}
}

// passwordLogin waits for the 2FA password on stdin; a wrong one may be typed again.
func passwordLogin(ctx context.Context, api *tg.Client, a *auth.Client, o AuthOptions) (*tg.AuthAuthorization, error) {
	hint := ""
	if pw, err := api.AccountGetPassword(ctx); err == nil {
		hint = pw.Hint
	}
	o.Events.Emit("password_needed", map[string]any{"hint": hint})
	for {
		in, err := next(ctx, o.Inputs)
		if err != nil {
			return nil, err
		}
		if in.Password == "" {
			continue
		}
		authz, err := a.Password(ctx, in.Password)
		var fe *FloodError
		switch {
		case err == nil:
			return authz, nil
		case errors.Is(err, auth.ErrPasswordInvalid):
			o.Events.Emit("password_invalid", nil)
		case errors.As(err, &fe):
			return nil, passwordFlood{fe}
		default:
			return nil, err
		}
	}
}

// Logout logs this device out of the account (this session only) and
// removes its session and identity files, whatever Telegram answered.
func Logout(ctx context.Context, app App, dir, version string) error {
	err := oneShot(ctx, app, dir, version, func(ctx context.Context, api *tg.Client) error {
		_, err := api.AuthLogOut(ctx)
		return err
	})
	if errors.Is(err, ErrNotLinked) || tgerr.Is(err, "AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "USER_DEACTIVATED") {
		err = nil // already gone on Telegram's side
	}
	for _, f := range []string{SessionFile, MeFile} {
		if rmErr := os.Remove(filepath.Join(dir, f)); rmErr != nil && !os.IsNotExist(rmErr) && err == nil {
			err = rmErr
		}
	}
	return err
}
