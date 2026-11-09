// Command tgcli reads a person's Telegram as a linked device (MTProto, the
// way Telegram Desktop does) and, outside read-only mode, sends from it. It is
// nanou's Telegram connector, shaped like wacli: --account, --read-only
// (or TGCLI_READONLY=1), --json, NDJSON auth events, and a local SQLite store
// that `sync --follow` keeps current.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/nanou-labs/connectors/linked/telegram/tgcli/internal/cli"
)

// version is set at build time (-ldflags "-X main.version=…").
var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	code := cli.Main(os.Args[1:], cli.Env{
		Ctx: ctx, Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr, Home: home, Version: version,
	})
	stop()
	os.Exit(code)
}
