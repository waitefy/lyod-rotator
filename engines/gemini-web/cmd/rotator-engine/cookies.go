package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

func atomicJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".engine-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// Import only on browser-login changes. Never overwrite newer engine rotations
// with the original login snapshot after a process/container restart.
func importCookies(file, home string) error {
	raw, err := os.ReadFile(file)
	if err != nil || len(raw) > 65536 {
		return errors.New("invalid cookies")
	}
	var values map[string]string
	if json.Unmarshal(raw, &values) != nil || strings.TrimSpace(values["__Secure-1PSID"]) == "" {
		return errors.New("invalid cookies")
	}
	if err = os.MkdirAll(filepath.Join(home, "accounts"), 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(home, "import.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	stamp := digest(string(raw))
	saved, readErr := os.ReadFile(filepath.Join(home, "login.sha256"))
	accountFile := filepath.Join(home, "accounts/account.json")
	if readErr == nil && string(saved) == stamp {
		if _, err = os.Stat(accountFile); err == nil {
			return nil
		}
	}
	// One-time migration of the Python client's rotated cookie cache. Only this
	// account's path is read; values and filenames never enter diagnostics.
	cache := filepath.Join(filepath.Dir(file), ".gemini-web-cache", digest(file)[:24])
	files, _ := filepath.Glob(filepath.Join(cache, ".cached_cookies_"+digest(strings.TrimSpace(values["__Secure-1PSID"]))[:32]+".json"))
	sort.Slice(files, func(i, j int) bool {
		a, ae := os.Stat(files[i])
		b, be := os.Stat(files[j])
		return ae == nil && be == nil && a.ModTime().Before(b.ModTime())
	})
	for _, p := range files {
		inputStat, inputErr := os.Stat(file)
		cacheStat, cacheErr := os.Stat(p)
		if inputErr != nil || cacheErr != nil || cacheStat.ModTime().Before(inputStat.ModTime()) {
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil || len(data) > 65536 {
			continue
		}
		var cookies map[string]any
		if json.Unmarshal(data, &cookies) != nil {
			continue
		}
		for _, raw := range array(cookies["cookies"]) {
			cookie := object(raw)
			domain := strings.TrimPrefix(text(cookie["domain"]), ".")
			if domain != "google.com" && !strings.HasSuffix(domain, ".google.com") {
				continue
			}
			if expiry, ok := cookie["expires"].(float64); ok && expiry > 0 && expiry < float64(time.Now().Unix()) {
				continue
			}
			if name, value := text(cookie["name"]), text(cookie["value"]); name != "" && value != "" {
				values[name] = value
			}
		}
	}
	var keys []string
	for k, v := range values {
		if strings.ContainsAny(k, ";=\r\n") || strings.ContainsAny(v, ";\r\n") {
			return errors.New("invalid cookie")
		}
		// Google's consent/abuse-exemption cookies can be required alongside
		// PSID. Retain the complete private login jar, including future names.
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var pairs []string
	for _, k := range keys {
		pairs = append(pairs, k+"="+values[k])
	}
	if err = atomicJSON(accountFile, map[string]any{"kind": "cookie", "name": "account", "cookies": strings.Join(pairs, "; ")}); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(home, "login.sha256"), []byte(stamp), 0600)
}
