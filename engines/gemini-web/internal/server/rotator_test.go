package server

import (
	"fmt"
	"testing"
)

func TestRotatorThinkingCachesAreIsolated(t *testing.T) {
	s, account := newTestHarness(false, true)
	s.Cfg.HomeDir = t.TempDir()
	account.Client = &mockUpstream{}
	messages := []map[string]any{
		{"role": "user", "content": "first"},
		{"role": "assistant", "content": "ack"},
		{"role": "user", "content": "next"},
	}
	prepare := func(effort string) *preparedGeneration {
		t.Helper()
		body := map[string]any{"model": "gemini-pro", "reasoning_effort": effort}
		p, err := s.prepareGeneration(t.Context(), body, AuthScope{OK: true, AccountID: account.ID}, messages, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	low := prepare("low")
	key := low.hasher.HashPrefix(account.ID, fmt.Sprintf("%s@think=%d", low.mid, low.opts.ThinkingLevel), 2)
	s.putSessionCache(key, []any{"low-only"})
	if len(prepare("low").opts.Metadata) == 0 {
		t.Fatal("same effort did not reuse continuation")
	}
	for _, effort := range []string{"medium", "high"} {
		if len(prepare(effort).opts.Metadata) != 0 {
			t.Fatal("effort cache collision")
		}
	}
}
