package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sonesh-2202/gemini-sentinel/internal/cookies"
)

func TestLoginImportPreservesRotatedCredentialsAndSeparatesAccounts(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "cookies.json")
	home := filepath.Join(dir, "engine")
	if err := os.WriteFile(file, []byte(`{"__Secure-1PSID":"initial","__Secure-1PSIDTS":"original","GOOGLE_ABUSE_EXEMPTION":"synthetic"}`), 0600); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(dir, ".gemini-web-cache", digest(file)[:24])
	if err := os.MkdirAll(cache, 0700); err != nil {
		t.Fatal(err)
	}
	cacheFile := filepath.Join(cache, ".cached_cookies_"+digest("initial")[:32]+".json")
	if err := os.WriteFile(cacheFile, []byte(`{"alias":"rotated","cookies":[{"name":"__Secure-1PSID","value":"rotated","domain":".google.com"},{"name":"__Secure-1PSIDTS","value":"fresh","domain":".google.com"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(cacheFile, time.Now().Add(time.Second), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := importCookies(file, home); err != nil {
		t.Fatal(err)
	}
	account := filepath.Join(home, "accounts/account.json")
	data, _ := os.ReadFile(account)
	if !strings.Contains(string(data), "GOOGLE_ABUSE_EXEMPTION=synthetic") {
		t.Fatal("required non-PSID cookie dropped")
	}
	cred, _, err := cookies.LoadAccountFile(account)
	if err != nil {
		t.Fatal(err)
	}
	header := cookies.CanonicalHeader(cookies.ParseHeader(cred.Cookies + "; FUTURE_LOGIN_COOKIE=keep"))
	header, _ = cookies.AbsorbSetCookie(header, []string{"__Secure-1PSIDTS=updated; Secure", "UNRELATED_COOKIE=ignore; Secure"})
	if !strings.Contains(header, "GOOGLE_ABUSE_EXEMPTION=synthetic") || !strings.Contains(header, "FUTURE_LOGIN_COOKIE=keep") || strings.Contains(header, "UNRELATED_COOKIE=") {
		t.Fatal("cookie normalization or rotation lost login state")
	}
	if !strings.Contains(string(data), "__Secure-1PSID=rotated") || !strings.Contains(string(data), "__Secure-1PSIDTS=fresh") {
		t.Fatal("rotated cache not migrated")
	}
	newer := []byte(`{"name":"account","cookies":"__Secure-1PSID=newest"}`)
	if err := os.WriteFile(account, newer, 0600); err != nil {
		t.Fatal(err)
	}
	if err := importCookies(file, home); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(account)
	if string(data) != string(newer) {
		t.Fatal("unchanged login rolled back rotated cookies")
	}
	if engineHome(file) == engineHome(filepath.Join(dir, "second.json")) {
		t.Fatal("account storage collision")
	}
	if err := os.WriteFile(file, []byte(`{"__Secure-1PSID":"relogin"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := importCookies(file, home); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(account)
	if !strings.Contains(string(data), "relogin") {
		t.Fatal("browser relogin was ignored")
	}
	stat, _ := os.Stat(account)
	if stat.Mode().Perm() != 0600 {
		t.Fatal("credentials not private")
	}
}
func TestStructuredHistoryAndInlineDocuments(t *testing.T) {
	var raw map[string]any
	if err := json.Unmarshal([]byte(`{"systemInstruction":{"parts":[{"text":"system"}]},"contents":[{"role":"user","parts":[{"text":"inspect"},{"inlineData":{"mimeType":"application/pdf","data":"cGRm"}}]},{"role":"model","parts":[{"functionCall":{"name":"read","args":{"path":"x"}}}]},{"role":"user","parts":[{"functionResponse":{"name":"read","response":{"result":"contents"}}}]}],"tools":[{"functionDeclarations":[{"name":"read","parameters":{"type":"object"}}]}],"toolConfig":{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["read"]}}}`), &raw); err != nil {
		t.Fatal(err)
	}
	for _, level := range []string{"low", "medium", "high"} {
		body, err := chatBody(request{Thinking: level, Request: raw})
		if err != nil {
			t.Fatal(err)
		}
		if body["reasoning_effort"] != level || body["model"] != "gemini-argon" {
			t.Fatal("wrong model/effort")
		}
		messages := array(body["messages"])
		if len(messages) != 4 || object(messages[0])["role"] != "system" || object(messages[3])["role"] != "tool" {
			t.Fatal("roles lost")
		}
		call := object(array(object(messages[2])["tool_calls"])[0])
		if call["id"] != object(messages[3])["tool_call_id"] {
			t.Fatal("call/result association lost")
		}
		parts := array(object(messages[1])["content"])
		file := object(object(parts[1])["file"])
		if file["file_data"] != "data:application/pdf;base64,"+base64.StdEncoding.EncodeToString([]byte("pdf")) {
			t.Fatal("document bytes lost")
		}
	}
}
func capture(t *testing.T, f func() error) (string, error) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	defer func() { os.Stdout = old; r.Close(); w.Close() }()
	err = f()
	w.Close()
	data, _ := io.ReadAll(r)
	return string(data), err
}
func TestStreamRequiresCompletionAndBuffersToolsUntilDone(t *testing.T) {
	stream := `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{\"path\":"}}]},"finish_reason":null}]}` + "\n\n"
	output, err := capture(t, func() error { return streamChat(strings.NewReader(stream)) })
	if err == nil || strings.Contains(output, `"type":"tools"`) {
		t.Fatal("incomplete tool escaped")
	}
	stream += `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]},"finish_reason":"tool_calls"}]}` + "\n\ndata: [DONE]\n\n"
	output, err = capture(t, func() error { return streamChat(strings.NewReader(stream)) })
	if err != nil || !strings.Contains(output, `"type":"tools"`) || !strings.Contains(output, `"path":"x"`) {
		t.Fatalf("tool stream failed: %v", err)
	}
}
func TestProgressiveText(t *testing.T) {
	stream := `data: {"choices":[{"delta":{"content":"first "},"finish_reason":null}]}` + "\n\n" + `data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"
	output, err := capture(t, func() error { return streamChat(strings.NewReader(stream)) })
	if err != nil || strings.Count(output, `"type":"delta"`) != 2 {
		t.Fatal("text deltas were buffered")
	}
}

func TestCitationFilterAcrossChunks(t *testing.T) {
	var f citationFilter
	got := f.feed("Heart[ci", false) + f.feed("te: 1]. [source](https://example.org) [", false) + f.feed("cite: 2]", true)
	if got != "Heart. [source](https://example.org) " {
		t.Fatal("unresolved markers leaked or Markdown lost")
	}
}
