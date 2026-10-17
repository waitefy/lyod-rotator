package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/sonesh-2202/gemini-sentinel/internal/gemini"
)

// ServeRotator is reachable only on the private, owner-only Unix socket.
func (s *Server) ServeRotator(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	accts := s.EnsureModels(ctx, false)
	fail := func(status int) { http.Error(w, "Gemini Web operation failed", status) }
	if len(accts) != 1 {
		fail(401)
		return
	}
	a := accts[0]
	if a.ModelsError != nil {
		fail(401)
		return
	}
	model := resolveModelOnAccount(a, "gemini-argon")
	if model == nil {
		fail(404)
		return
	}
	client, ok := a.Client.(*gemini.AccountClient)
	if !ok {
		fail(503)
		return
	}
	var in struct {
		Prompt          string `json:"prompt"`
		Output          string `json:"output"`
		Thinking        string `json:"thinkingLevel"`
		IncludeIdentity bool   `json:"includeIdentity"`
		Attachments     []struct {
			MIME string `json:"mimeType"`
			Data string `json:"data"`
		} `json:"attachments"`
	}
	if r.Method != "POST" || json.NewDecoder(io.LimitReader(r.Body, 40*1024*1024)).Decode(&in) != nil {
		fail(400)
		return
	}
	write := func(v any) {
		_ = json.NewEncoder(w).Encode(v)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	if r.URL.Path == "/rotator/probe" {
		usage, err := client.RotatorUsage(ctx)
		if err != nil {
			fail(502)
			return
		}
		result := map[string]any{"type": "done", "usage": usage}
		if in.IncludeIdentity {
			identity, err := client.RotatorIdentity(ctx)
			if err != nil {
				fail(401)
				return
			}
			result["identity"] = identity
		}
		write(map[string]any{"type": "ready"})
		write(result)
		return
	}
	level, ok := gemini.ThinkingLevels[in.Thinking]
	if !ok || in.Prompt == "" || len(in.Prompt) > 4*1024*1024 || len(in.Attachments) > 8 {
		fail(400)
		return
	}
	opts := gemini.StreamOptions{Model: model, ThinkingLevel: level, Temporary: true, DisableTools: false}
	total := 0
	for i, att := range in.Attachments {
		data, err := base64.StdEncoding.DecodeString(att.Data)
		total += len(data)
		if err != nil || len(data) > 5*1024*1024 || total > 10*1024*1024 {
			fail(400)
			return
		}
		ext := map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv"}[att.MIME]
		if ext == "" {
			fail(400)
			return
		}
		file, err := client.UploadFile(ctx, data, fmt.Sprintf("attachment_%d.%s", i+1, ext), att.MIME)
		if err != nil {
			fail(502)
			return
		}
		opts.Files = append(opts.Files, file)
	}
	var image *gemini.GeneratedImage
	servedID, servedLabel, answer := "", "", ""
	complete, conflict := false, false
	observe := func(id, label string) {
		if id != "" {
			if servedID != "" && servedID != id {
				conflict = true
			}
			servedID = id
		}
		if label != "" {
			servedLabel = label
		}
	}
	res, err := client.StreamGenerateLive(ctx, in.Prompt, opts, func(update *gemini.LineParseResult) error {
		observe(update.AnsweredModelID, update.AnsweredModelLabel)
		for _, f := range update.Frames {
			observe(f.AnsweredModelID, f.AnsweredModelLabel)
			answer = f.Text
			complete = complete || f.Done
			if len(f.GeneratedImages) > 0 {
				img := f.GeneratedImages[0]
				image = &img
			}
		}
		return nil
	})
	if err != nil || res == nil || res.Status != 200 || !complete || conflict || servedID == "" || !gemini.IsMatchingServedModel(*model, servedID, servedLabel) {
		fail(502)
		return
	}
	if image == nil {
		if in.Output == "image" || strings.TrimSpace(answer) == "" {
			fail(502)
			return
		}
		write(map[string]any{"type": "ready"})
		write(map[string]any{"type": "delta", "text": answer})
		write(map[string]any{"type": "done"})
		return
	}
	data, mime, err := client.RotatorDownloadImage(ctx, image.URL)
	if err != nil {
		fail(502)
		return
	}
	write(map[string]any{"type": "ready"})
	write(map[string]any{"type": "image", "mimeType": mime, "data": base64.StdEncoding.EncodeToString(data)})
	write(map[string]any{"type": "diagnostic", "engine": "sentinel", "servedModelId": servedID, "thinkingLevel": level, "completedAt": time.Now().Unix()})
	write(map[string]any{"type": "done"})
}
