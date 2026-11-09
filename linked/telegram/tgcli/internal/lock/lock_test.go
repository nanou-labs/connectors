package lock

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestOneHolderAtATime(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sync.lock")
	first, err := Acquire(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(path, 300*time.Millisecond); !errors.Is(err, ErrLocked) {
		t.Fatalf("second holder: %v", err)
	}
	first.Release()
	second, err := Acquire(path, 0)
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	second.Release()
}
