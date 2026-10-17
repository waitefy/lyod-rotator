package gemini

import (
	"context"
	"io"
	"strings"
	"testing"

	fhttp "github.com/bogdanfinn/fhttp"
	"github.com/sonesh-2202/gemini-sentinel/internal/transport"
)

func TestRotatorImageDownloadRedirects(t *testing.T) {
	for _, tc := range []struct {
		name, location string
		wantOK         bool
		wantCalls      int
	}{
		{"google-image", "https://work.fife.usercontent.google.com/image", true, 2},
		{"foreign-origin", "https://example.com/image", false, 1},
		{"insecure", "http://work.fife.usercontent.google.com/image", false, 1},
		{"credentials", "https://user@work.fife.usercontent.google.com/image", false, 1},
		{"custom-port", "https://work.fife.usercontent.google.com:8443/image", false, 1},
		{"loop", "https://lh3.googleusercontent.com/loop", false, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			doer := &stubGeminiDoer{fn: func(req *fhttp.Request) (*fhttp.Response, error) {
				calls++
				if req.URL.Host == "work.fife.usercontent.google.com" {
					if strings.Join(req.Header["cookie"], "") != "__Secure-1PSID=synthetic" {
						t.Error("authenticated Google image handoff missing cookies")
					}
					return &fhttp.Response{StatusCode: 200, Header: fhttp.Header{}, Body: io.NopCloser(strings.NewReader("\x89PNG\r\n\x1a\nimage"))}, nil
				}
				return &fhttp.Response{StatusCode: 302, Header: fhttp.Header{"Location": []string{tc.location}}, Body: io.NopCloser(strings.NewReader("redirect"))}, nil
			}}
			pool := transport.NewPool(transport.PoolOptions{ClientConfig: transport.ClientConfig{CustomDoer: doer}, MaxSessions: 1})
			ac := NewAccountClient("image-test", "__Secure-1PSID=synthetic", "", pool, nil)
			data, mime, err := ac.RotatorDownloadImage(context.Background(), "https://lh3.googleusercontent.com/image")
			if (err == nil) != tc.wantOK || calls != tc.wantCalls {
				t.Fatalf("success=%v calls=%d; want success=%v calls=%d", err == nil, calls, tc.wantOK, tc.wantCalls)
			}
			if tc.wantOK && (mime != "image/png" || len(data) == 0) {
				t.Fatal("missing image bytes")
			}
		})
	}
}

func TestRotatorConflictingIDCannotBeRescuedByLabel(t *testing.T) {
	m := ModelInfo{ModelID: "argon-id", ModelName: "gemini-argon", DisplayName: "Argon"}
	if IsMatchingServedModel(m, "flash-id", "Argon") {
		t.Fatal("conflicting ID accepted via label")
	}
	if !IsMatchingServedModel(m, "argon-id", "Argon") {
		t.Fatal("matching ID rejected")
	}
}
