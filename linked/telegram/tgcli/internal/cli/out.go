package cli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

// Output prints results: the JSON envelope with --json, else plain text.
type Output struct {
	JSON   bool
	Stdout io.Writer
	Stderr io.Writer
}

// OK prints a result. human prints it as text when --json is off (nil: the JSON anyway).
func (o Output) OK(data any, human func(w io.Writer)) {
	if o.JSON || human == nil {
		enc := json.NewEncoder(o.Stdout)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(map[string]any{"success": true, "data": data})
		return
	}
	human(o.Stdout)
}

// Fail prints an error and returns the exit code (1).
func (o Output) Fail(err error) int {
	if o.JSON {
		enc := json.NewEncoder(o.Stdout)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(map[string]any{"success": false, "error": err.Error()})
	} else {
		fmt.Fprintf(o.Stderr, "tgcli: %v\n", err)
	}
	return 1
}

// Events writes auth's NDJSON events, {"event","data","ts"}, one per line.
type Events struct {
	mu  sync.Mutex
	W   io.Writer
	On  bool
	Now func() time.Time
}

// Emit writes one event (only with --events; plain text otherwise is the caller's).
func (e *Events) Emit(name string, data map[string]any) {
	if e == nil || !e.On {
		return
	}
	if data == nil {
		data = map[string]any{}
	}
	now := time.Now
	if e.Now != nil {
		now = e.Now
	}
	line, err := json.Marshal(map[string]any{"event": name, "data": data, "ts": now().Unix()})
	if err != nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	_, _ = e.W.Write(append(line, '\n'))
}

// Input is one answer typed for auth: a login code or the 2FA password.
type Input struct {
	Code     string
	Password string
}

// ParseInput reads one stdin line: {"code":"…"} or {"password":"…"}, or
// (typed by hand without --events) the bare value of what is awaited.
func ParseInput(line string, events bool) (Input, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return Input{}, false
	}
	if strings.HasPrefix(trimmed, "{") {
		var in struct {
			Code     *string `json:"code"`
			Password *string `json:"password"`
		}
		if json.Unmarshal([]byte(trimmed), &in) != nil {
			return Input{}, false
		}
		switch {
		case in.Code != nil:
			code := strings.Map(func(r rune) rune {
				if r == ' ' || r == '-' {
					return -1
				}
				return r
			}, *in.Code)
			if code == "" {
				return Input{}, false
			}
			return Input{Code: code}, true
		case in.Password != nil && *in.Password != "":
			return Input{Password: *in.Password}, true
		}
		return Input{}, false
	}
	if events {
		return Input{}, false // the provisioner only ever sends JSON
	}
	// By hand: the raw line is both; the flow takes what it waits for.
	return Input{Code: strings.ReplaceAll(trimmed, " ", ""), Password: strings.TrimRight(line, "\r\n")}, true
}

// ReadInputs feeds stdin's answers into a channel until stdin closes.
func ReadInputs(r io.Reader, events bool) <-chan Input {
	ch := make(chan Input, 4)
	go func() {
		defer close(ch)
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 64*1024)
		for sc.Scan() {
			if in, ok := ParseInput(sc.Text(), events); ok {
				ch <- in
			}
		}
	}()
	return ch
}
