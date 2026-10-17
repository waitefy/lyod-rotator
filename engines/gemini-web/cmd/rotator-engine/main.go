// Rotator's private stdio/Unix-socket boundary. No TCP listener or account failover.
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/sonesh-2202/gemini-sentinel/internal/config"
	"github.com/sonesh-2202/gemini-sentinel/internal/server"
)

var sourceCommit = "development"

const deadline = 120 * time.Second

func emit(value any) { _ = json.NewEncoder(os.Stdout).Encode(value) }
func failure(status int, message string) {
	emit(map[string]any{"type": "error", "status": status, "message": message})
}
func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func main() {
	log.SetOutput(io.Discard)
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(sourceCommit)
		return
	}
	if len(os.Args) > 2 && os.Args[1] == "--serve" {
		if serve(os.Args[2]) != nil {
			os.Exit(1)
		}
		return
	}
	var in request
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 40*1024*1024)).Decode(&in); err != nil {
		failure(400, "Invalid Gemini Web engine request")
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	ctx, stop := context.WithTimeout(ctx, deadline)
	defer stop()
	if err := run(ctx, in); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			failure(504, "Gemini Web engine request timed out")
		} else if ctx.Err() == nil {
			failure(502, "Gemini Web engine request failed; check session access and connectivity")
		}
	}
}

func engineHome(file string) string {
	base := os.Getenv("TUXEVIL_ROTATOR_GEMINI_ENGINE_STATE_DIR")
	if base == "" {
		base = filepath.Join(filepath.Dir(file), ".gemini-web-engine")
	}
	return filepath.Join(base, digest(file)[:24])
}
func socketPath(home string) string {
	// sockaddr_un paths are limited to 108 bytes, independent of the cookie path.
	return filepath.Join(os.TempDir(), fmt.Sprintf("rotator-gemini-%d-%s.sock", os.Getuid(), digest(home)[:24]))
}
func clientFor(home string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath(home))
	}}}
}
func ensureEngine(ctx context.Context, home string) error {
	check := func() bool {
		c := clientFor(home)
		defer c.CloseIdleConnections()
		r, err := http.NewRequestWithContext(ctx, "GET", "http://engine/health", nil)
		if err != nil {
			return false
		}
		res, err := c.Do(r)
		if err != nil {
			return false
		}
		defer res.Body.Close()
		return res.StatusCode == 200
	}
	if check() {
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--serve", home)
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err = cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	for i := 0; i < 100; i++ {
		if check() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return errors.New("engine unavailable")
}

func serve(home string) error {
	if err := os.MkdirAll(home, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(home, "engine.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	sock := socketPath(home)
	_ = os.Remove(sock)
	listener, err := net.Listen("unix", sock)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(sock)
	if err = os.Chmod(sock, 0600); err != nil {
		return err
	}
	cfg := config.Load()
	cfg.HomeDir = home
	cfg.AccountsDir = filepath.Join(home, "accounts")
	cfg.CredFile = ""
	cfg.CookieDB = ""
	cfg.APIKey = ""
	cfg.AutoAdminKey = false
	cfg.AccountTokens = map[string]string{"rotator-private": "account"}
	cfg.Temporary = false
	cfg.RejectDowngrade = true
	cfg.SessionCache = true
	cfg.KeepToolPreamble = true
	cfg.LiveThoughts = false
	cfg.DefaultThinking = 1
	// Rotator already enforces its 4 MiB text budget. Reserve room for the
	// engine's protocol instructions and schemas without truncating tool history.
	cfg.MaxPromptChars = 8 * 1024 * 1024
	cfg.MaxOldToolChars = 8 * 1024 * 1024
	cfg.LogLevel = "silent"
	cfg.StreamTimeout = deadline
	cfg.FirstByteTimeout = 65 * time.Second
	cfg.StallTimeout = 65 * time.Second
	cfg.SessionWaitTimeout = 10 * time.Second
	cfg.MaxSessions = 1
	cfg.MaxQueueDepth = 1
	cfg.ProxyURL = os.Getenv("ROTATOR_ENGINE_PROXY")
	s := server.New(cfg)
	if s.LoadCredentials() != 1 {
		return errors.New("expected one account")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	s.StartBackgroundWorkers(ctx)
	mux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" && r.URL.Path != "/v1/chat/completions" && r.URL.Path != "/rotator/probe" && r.URL.Path != "/rotator/image" {
			http.NotFound(w, r)
			return
		}
		r.Header.Set("Authorization", "Bearer rotator-private")
		if strings.HasPrefix(r.URL.Path, "/rotator/") {
			s.ServeRotator(w, r)
			return
		}
		s.ServeHTTP(w, r)
	})
	h := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() {
		<-ctx.Done()
		shut, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = h.Shutdown(shut)
		s.Pool.Reset()
	}()
	return h.Serve(listener)
}

func run(ctx context.Context, in request) error {
	file, err := filepath.Abs(in.CookiesFile)
	if err != nil || in.CookiesFile == "" {
		failure(401, "Gemini Web requires cookiesFile")
		return nil
	}
	home := engineHome(file)
	if err = importCookies(file, home); err != nil {
		failure(401, "Cannot read Gemini Web cookie JSON; reconnect the web session")
		return nil
	}
	if in.Proxy != "" {
		_ = os.Setenv("ROTATOR_ENGINE_PROXY", in.Proxy)
	} else {
		_ = os.Unsetenv("ROTATOR_ENGINE_PROXY")
	}
	if err = ensureEngine(ctx, home); err != nil {
		return err
	}
	var body any
	path := "/v1/chat/completions"
	if in.Mode == "probe" {
		path = "/rotator/probe"
		body = in
	} else if in.Output == "image" || in.Output == "image-or-text" {
		path = "/rotator/image"
		body = in
	} else {
		body, err = chatBody(in)
		if err != nil {
			failure(400, "Invalid Gemini Web engine conversation")
			return nil
		}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	c := clientFor(home)
	defer c.CloseIdleConnections()
	r, err := http.NewRequestWithContext(ctx, "POST", "http://engine"+path, strings.NewReader(string(encoded)))
	if err != nil {
		return err
	}
	r.Header.Set("Content-Type", "application/json")
	res, err := c.Do(r)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		status := res.StatusCode
		if status < 400 || status > 599 {
			status = 502
		}
		failure(status, "Gemini Web engine rejected request; check model availability, session or quota")
		return nil
	}
	if path != "/v1/chat/completions" {
		scanner := bufio.NewScanner(io.LimitReader(res.Body, 16*1024*1024))
		scanner.Buffer(make([]byte, 65536), 12*1024*1024)
		for scanner.Scan() {
			var event map[string]any
			if json.Unmarshal(scanner.Bytes(), &event) != nil {
				return errors.New("invalid event")
			}
			emit(event)
		}
		return scanner.Err()
	}
	return streamChat(res.Body)
}
