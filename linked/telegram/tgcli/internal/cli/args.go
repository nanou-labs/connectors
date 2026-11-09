// Package cli is tgcli's command line: flags, the JSON envelope, auth
// events, and the commands themselves.
package cli

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

// boolFlags take no value; every other --flag takes one.
var boolFlags = map[string]bool{
	"read-only": true, "json": true, "events": true, "version": true, "help": true,
	"follow": true, "qr": true,
}

// globalFlags may sit anywhere on the line (before or after the subcommand).
var globalFlags = map[string]bool{
	"account": true, "store": true, "lock-wait": true,
	"read-only": true, "json": true, "events": true, "version": true, "help": true,
}

// Args is a parsed command line.
type Args struct {
	Account  string
	Store    string
	LockWait time.Duration
	ReadOnly bool
	JSON     bool
	Events   bool
	Version  bool
	Help     bool
	// Words are the subcommand and its positional arguments.
	Words []string
	// Flags are the subcommand's own flags (bool ones as "true").
	Flags map[string]string
}

// accountName keeps account names to plain folder names.
var accountName = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$`)

// ValidAccount reports whether a name can be an account folder.
func ValidAccount(name string) bool { return accountName.MatchString(name) }

// Parse reads argv (without the program name).
func Parse(argv []string) (Args, error) {
	a := Args{Account: "default", LockWait: 0, Flags: map[string]string{}}
	for i := 0; i < len(argv); i++ {
		w := argv[i]
		if w == "--" {
			a.Words = append(a.Words, argv[i+1:]...)
			break
		}
		if w == "-h" {
			a.Help = true
			continue
		}
		if !strings.HasPrefix(w, "--") || w == "--" {
			a.Words = append(a.Words, w)
			continue
		}
		name, value, hasValue := strings.Cut(strings.TrimPrefix(w, "--"), "=")
		if boolFlags[name] {
			if hasValue && value != "true" && value != "false" {
				return a, fmt.Errorf("--%s takes no value", name)
			}
			if !hasValue {
				value = "true"
			}
		} else if !hasValue {
			if i+1 >= len(argv) {
				return a, fmt.Errorf("--%s needs a value", name)
			}
			i++
			value = argv[i]
		}
		if !globalFlags[name] {
			a.Flags[name] = value
			continue
		}
		on := value == "true"
		switch name {
		case "account":
			a.Account = value
		case "store":
			a.Store = value
		case "lock-wait":
			d, err := time.ParseDuration(value)
			if err != nil {
				return a, fmt.Errorf("--lock-wait: %w", err)
			}
			a.LockWait = d
		case "read-only":
			a.ReadOnly = on
		case "json":
			a.JSON = on
		case "events":
			a.Events = on
		case "version":
			a.Version = on
		case "help":
			a.Help = on
		}
	}
	if !ValidAccount(a.Account) {
		return a, fmt.Errorf("bad account name %q (lowercase letters, digits, - or _)", a.Account)
	}
	return a, nil
}

// readOnlyEnv is true when TGCLI_READONLY asks for read-only.
func readOnlyEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("TGCLI_READONLY"))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// IsReadOnly is true when this run may not change anything.
func (a Args) IsReadOnly() bool { return a.ReadOnly || readOnlyEnv() }

// Check refuses flags the subcommand doesn't take.
func (a Args) Check(allowed ...string) error {
	ok := map[string]bool{}
	for _, f := range allowed {
		ok[f] = true
	}
	for f := range a.Flags {
		if !ok[f] {
			return fmt.Errorf("unknown flag --%s for %q", f, strings.Join(a.Words, " "))
		}
	}
	return nil
}

// Int reads an integer flag, or def when it isn't given.
func (a Args) Int(name string, def int) (int, error) {
	v, ok := a.Flags[name]
	if !ok {
		return def, nil
	}
	var n int
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil || fmt.Sprint(n) != strings.TrimSpace(v) {
		return 0, fmt.Errorf("--%s must be a whole number", name)
	}
	return n, nil
}
