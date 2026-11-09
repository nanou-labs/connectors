// Package lock is an account's sync lock: one `sync` (or `auth`) per
// account at a time, with an advisory flock on <account>/sync.lock (works on
// Linux and macOS).
package lock

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// ErrLocked is returned when another tgcli holds the lock past the wait.
var ErrLocked = errors.New("the account is locked by another tgcli (a sync running?)")

// Lock is a held lock.
type Lock struct{ f *os.File }

// Acquire takes the lock at path, retrying until wait has passed.
func Acquire(path string, wait time.Duration) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return &Lock{f: f}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			_ = f.Close()
			return nil, err
		}
		if time.Now().After(deadline) {
			_ = f.Close()
			return nil, ErrLocked
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// Release lets the lock go.
func (l *Lock) Release() {
	if l != nil && l.f != nil {
		_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
		_ = l.f.Close()
	}
}
