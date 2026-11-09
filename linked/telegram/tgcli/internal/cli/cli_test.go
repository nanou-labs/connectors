package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nanou-labs/connectors/linked/telegram/tgcli/internal/store"
)

func TestParseGlobalsAnywhere(t *testing.T) {
	a, err := Parse([]string{"chats", "--json", "list", "--account", "ana-work", "--query=school", "--read-only", "--limit", "5"})
	if err != nil {
		t.Fatal(err)
	}
	if a.Account != "ana-work" || !a.JSON || !a.ReadOnly || strings.Join(a.Words, " ") != "chats list" {
		t.Fatalf("parsed %+v", a)
	}
	if a.Flags["query"] != "school" || a.Flags["limit"] != "5" {
		t.Fatalf("flags %+v", a.Flags)
	}
	if n, err := a.Int("limit", 50); err != nil || n != 5 {
		t.Fatalf("limit %d %v", n, err)
	}
	if err := a.Check("query"); err == nil {
		t.Fatal("--limit should be refused when not allowed")
	}
	a, _ = Parse([]string{"--lock-wait", "60s", "--events", "auth", "--phone", "+33 6 39 98 12 34"})
	if a.LockWait != time.Minute || !a.Events || a.Flags["phone"] != "+33 6 39 98 12 34" {
		t.Fatalf("auth parse %+v", a)
	}
	for _, bad := range [][]string{
		{"--account", "../x", "chats", "list"},
		{"--account", "Ana", "chats", "list"},
		{"chats", "list", "--limit"},
		{"--json=yes", "chats", "list"},
		{"--lock-wait", "soon", "sync"},
	} {
		if _, err := Parse(bad); err == nil {
			t.Fatalf("Parse(%q) should fail", bad)
		}
	}
	if a, _ := Parse([]string{"send", "text", "--message", "--json"}); a.Flags["message"] != "--json" || a.JSON {
		t.Fatalf("a value that looks like a flag is still the value: %+v", a)
	}
	if _, err := (Args{Flags: map[string]string{"limit": "5x"}}).Int("limit", 1); err == nil {
		t.Fatal("5x is not a number")
	}
}

func TestReadOnlyEnv(t *testing.T) {
	t.Setenv("TGCLI_READONLY", "1")
	if !(Args{}).IsReadOnly() {
		t.Fatal("TGCLI_READONLY=1 must mean read-only")
	}
	t.Setenv("TGCLI_READONLY", "0")
	if (Args{}).IsReadOnly() || !(Args{ReadOnly: true}).IsReadOnly() {
		t.Fatal("TGCLI_READONLY=0 is writable unless --read-only")
	}
}

func TestEnvelope(t *testing.T) {
	var out bytes.Buffer
	o := Output{JSON: true, Stdout: &out, Stderr: &out}
	o.OK([]int{1}, nil)
	if got := strings.TrimSpace(out.String()); got != `{"data":[1],"success":true}` {
		t.Fatalf("ok envelope %s", got)
	}
	out.Reset()
	if code := o.Fail(ErrReadOnly); code != 1 {
		t.Fatalf("exit %d", code)
	}
	var env map[string]any
	if err := json.Unmarshal(out.Bytes(), &env); err != nil || env["success"] != false || env["error"] != ErrReadOnly.Error() {
		t.Fatalf("fail envelope %s", out.String())
	}
}

func TestEvents(t *testing.T) {
	var out bytes.Buffer
	e := &Events{W: &out, On: true, Now: func() time.Time { return time.Unix(42, 0) }}
	e.Emit("qr_code", map[string]any{"url": "tg://login?token=abc", "expires": 99})
	e.Emit("code_invalid", nil)
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || lines[0] != `{"data":{"expires":99,"url":"tg://login?token=abc"},"event":"qr_code","ts":42}` ||
		lines[1] != `{"data":{},"event":"code_invalid","ts":42}` {
		t.Fatalf("events %q", lines)
	}
	(&Events{W: &out}).Emit("x", nil)
	if len(strings.Split(strings.TrimSpace(out.String()), "\n")) != 2 {
		t.Fatal("events off must print nothing")
	}
}

func TestParseInput(t *testing.T) {
	if in, ok := ParseInput(`{"code":"12 345"}`, true); !ok || in.Code != "12345" || in.Password != "" {
		t.Fatalf("code %+v", in)
	}
	if in, ok := ParseInput(`{"password":" sp ace "}`, true); !ok || in.Password != " sp ace " || in.Code != "" {
		t.Fatalf("password kept as typed %+v", in)
	}
	for _, line := range []string{"", "12345", `{"code":""}`, `{"other":1}`, `{bad json`} {
		if _, ok := ParseInput(line, true); ok {
			t.Fatalf("ParseInput(%q) with --events should be ignored", line)
		}
	}
	if in, ok := ParseInput("12 345\n", false); !ok || in.Code != "12345" {
		t.Fatalf("typed by hand %+v", in)
	}
	ch := ReadInputs(strings.NewReader("{\"code\":\"1\"}\nnoise\n{\"password\":\"p\"}\n"), true)
	var got []Input
	for in := range ch {
		got = append(got, in)
	}
	if len(got) != 2 || got[0].Code != "1" || got[1].Password != "p" {
		t.Fatalf("ReadInputs %+v", got)
	}
}

func TestNormalizePhoneAndSize(t *testing.T) {
	if p, err := NormalizePhone("+33 6 39-98 12 34"); err != nil || p != "+33639981234" {
		t.Fatalf("phone %s %v", p, err)
	}
	for _, bad := range []string{"0639981234", "+0639981234", "+12", "abc"} {
		if _, err := NormalizePhone(bad); err == nil {
			t.Fatalf("NormalizePhone(%q) should fail", bad)
		}
	}
	for in, want := range map[string]int64{"2GB": 2 << 30, "500mb": 500 << 20, "1024": 1024} {
		if n, err := ParseSize(in); err != nil || n != want {
			t.Fatalf("ParseSize(%s) = %d %v", in, n, err)
		}
	}
	if _, err := ParseSize("lots"); err == nil {
		t.Fatal("bad size")
	}
}

// fixture is a home with one synced account ("ana").
func fixture(t *testing.T) (home string) {
	t.Helper()
	home = t.TempDir()
	dir := filepath.Join(home, ".local", "state", "tgcli", "ana")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "store.db"))
	if err != nil {
		t.Fatal(err)
	}
	user := "anam"
	_ = st.UpsertChat(store.Chat{ID: "42", Kind: store.KindUser, RawID: 42, Name: "Ana", Type: "user", Username: &user})
	_ = st.UpsertChat(store.Chat{ID: "-5", Kind: store.KindChat, RawID: 5, Name: "School", Type: "group"})
	_ = st.UpsertMessage(store.Message{ChatID: "-5", ID: 7, FromID: "42", FromName: "Ana", Unix: 1000, Text: "pickup at four"})
	_ = st.Close()
	_ = os.WriteFile(filepath.Join(dir, "session.json"), []byte(`{"Version":1}`), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "me.json"), []byte(`{"user_id":9,"phone":"33639980000","name":"Ana M","username":null}`), 0o600)
	_ = os.MkdirAll(filepath.Join(home, ".local", "state", "tgcli", "bob"), 0o700)
	return home
}

func runCLI(t *testing.T, home string, args ...string) (int, map[string]any) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Main(args, Env{Ctx: context.Background(), Stdin: strings.NewReader(""), Stdout: &out, Stderr: &errOut, Home: home, Version: "test"})
	var env map[string]any
	if err := json.Unmarshal(out.Bytes(), &env); err != nil {
		t.Fatalf("%v: not JSON: %q (stderr %q)", args, out.String(), errOut.String())
	}
	return code, env
}

func TestReadsFromTheStore(t *testing.T) {
	home := fixture(t)
	t.Setenv("TGCLI_READONLY", "1")
	code, env := runCLI(t, home, "--account", "ana", "--json", "chats", "list")
	if code != 0 || len(env["data"].([]any)) != 2 {
		t.Fatalf("chats list %d %v", code, env)
	}
	_, env = runCLI(t, home, "--account", "ana", "--read-only", "--json", "chats", "show", "--chat", "@anam")
	if env["data"].(map[string]any)["name"] != "Ana" {
		t.Fatalf("chats show %v", env)
	}
	_, env = runCLI(t, home, "--account", "ana", "--json", "messages", "search", "pickup", "--chat", "School")
	hits := env["data"].([]any)
	if len(hits) != 1 || hits[0].(map[string]any)["chat_name"] != "School" {
		t.Fatalf("search %v", env)
	}
	_, env = runCLI(t, home, "--account", "ana", "--json", "messages", "show", "--chat", "-5", "--id", "7")
	if env["data"].(map[string]any)["text"] != "pickup at four" {
		t.Fatalf("show %v", env)
	}
	_, env = runCLI(t, home, "--account", "ana", "--json", "messages", "list", "--chat", "-5")
	if len(env["data"].([]any)) != 1 {
		t.Fatalf("list %v", env)
	}
	_, env = runCLI(t, home, "--json", "accounts", "list")
	accounts := env["data"].(map[string]any)["accounts"].([]any)
	if len(accounts) != 2 || accounts[0].(map[string]any)["linked"] != true || accounts[1].(map[string]any)["linked"] != false {
		t.Fatalf("accounts %v", env)
	}
	_, env = runCLI(t, home, "--account", "ana", "--json", "auth", "status")
	if d := env["data"].(map[string]any); d["authenticated"] != true || d["phone"] != "33639980000" || d["user_id"] != float64(9) {
		t.Fatalf("status %v", env)
	}
	_, env = runCLI(t, home, "--account", "bob", "--json", "auth", "status")
	if env["data"].(map[string]any)["authenticated"] != false {
		t.Fatalf("bob %v", env)
	}
	// An account never synced: a list is empty, a lookup fails.
	if code, env := runCLI(t, home, "--account", "bob", "--json", "chats", "list"); code != 0 || len(env["data"].([]any)) != 0 {
		t.Fatalf("empty list %v", env)
	}
	if code, _ := runCLI(t, home, "--account", "bob", "--json", "chats", "show", "--chat", "1"); code != 1 {
		t.Fatal("show without a store should fail")
	}
}

func TestReadOnlyRefusesEveryWrite(t *testing.T) {
	home := fixture(t)
	writes := [][]string{
		{"send", "text", "--to", "42", "--message", "hi"},
		{"send", "file", "--to", "42", "--file", "/etc/hostname"},
		{"media", "download", "--chat", "-5", "--id", "7"},
		{"auth", "--qr"},
		{"auth", "logout"},
		{"sync", "--follow"},
		{"accounts", "remove", "ana"},
	}
	for _, env := range []string{"1", ""} {
		t.Setenv("TGCLI_READONLY", env)
		for _, w := range writes {
			args := append([]string{"--account", "ana", "--json"}, w...)
			if env == "" {
				args = append(args, "--read-only")
			}
			code, out := runCLI(t, home, args...)
			if code != 1 || out["error"] != ErrReadOnly.Error() {
				t.Fatalf("%v (TGCLI_READONLY=%q) = %d %v", w, env, code, out)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".local", "state", "tgcli", "ana", "store.db")); err != nil {
		t.Fatal("the account must still be there")
	}
}

func TestWritesNeedTheAppCredentials(t *testing.T) {
	home := fixture(t)
	t.Setenv("TGCLI_READONLY", "0")
	t.Setenv("TGCLI_API_ID", "")
	var out, errOut bytes.Buffer
	code := Main([]string{"--account", "bob", "--events", "auth", "--phone", "+33639981234"},
		Env{Ctx: context.Background(), Stdin: strings.NewReader(""), Stdout: &out, Stderr: &errOut, Home: home})
	if code != 1 || !strings.Contains(errOut.String(), `"kind":"app_missing"`) {
		t.Fatalf("auth without app: %d %q", code, errOut.String())
	}
	errOut.Reset()
	code = Main([]string{"--account", "bob", "--events", "auth", "--phone", "0612"},
		Env{Ctx: context.Background(), Stdin: strings.NewReader(""), Stdout: &out, Stderr: &errOut, Home: home})
	if code != 1 || !strings.Contains(errOut.String(), `"event":"error"`) {
		t.Fatalf("bad number: %d %q", code, errOut.String())
	}
	if code, out := runCLI(t, home, "--json", "frobnicate"); code != 1 || !strings.Contains(out["error"].(string), "unknown command") {
		t.Fatalf("unknown command %v", out)
	}
}
