package gemini

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/sonesh-2202/gemini-sentinel/internal/transport"
)

func (ac *AccountClient) RotatorDownloadImage(ctx context.Context, rawURL string) ([]byte, string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || u.Host != "lh3.googleusercontent.com" || u.User != nil {
		return nil, "", errors.New("invalid image origin")
	}
	sess, err := ac.acquireSession(ctx)
	if err != nil {
		return nil, "", err
	}
	res, err := sess.Client.Do(ctx, transport.RequestOptions{Method: "GET", URL: u.String(), Headers: map[string]string{"cookie": ac.CookieHeader()}, Timeout: 45 * time.Second})
	if err != nil {
		return nil, "", err
	}
	data := []byte(res.Body)
	mime := strings.Split(http.DetectContentType(data), ";")[0]
	if res.Status != 200 || len(data) > 8*1024*1024 || (mime != "image/png" && mime != "image/jpeg" && mime != "image/webp") {
		return nil, "", errors.New("invalid generated image")
	}
	return data, mime, nil
}
func (ac *AccountClient) RotatorIdentity(ctx context.Context) (map[string]any, error) {
	sess, err := ac.acquireSession(ctx)
	if err != nil {
		return nil, err
	}
	res, err := sess.Client.Do(ctx, transport.RequestOptions{Method: "GET", URL: Origin + "/app", Headers: map[string]string{"cookie": ac.CookieHeader()}, Kind: transport.ReqKindNavigate, Timeout: 30 * time.Second})
	if err != nil {
		return nil, err
	}
	id := regexp.MustCompile(`"S06Grb":"([0-9]{6,32})"`).FindStringSubmatch(res.Body)
	email := matchFirst(emailRe, res.Body)
	if res.Status != 200 || len(id) != 2 || !strings.Contains(email, "@") {
		return nil, errors.New("missing identity")
	}
	return map[string]any{"email": email, "id": id[1]}, nil
}

// Same GetUsageInfo RPC/metric schema used by the pinned Python client. Never
// substitute legacy request-count quotas for Argon's compute windows.
func (ac *AccountClient) RotatorUsage(ctx context.Context) (map[string]any, error) {
	res, entries, err := ac.BatchExec(ctx, "jSf9Qc", "[]")
	if err != nil {
		return nil, err
	}
	if res.Status != 200 {
		return nil, errors.New("quota unavailable")
	}
	usage := map[string]any{}
	for _, entry := range entries {
		if entry.RPCID != "jSf9Qc" {
			continue
		}
		body, _ := entry.Payload.([]any)
		if len(body) < 2 {
			continue
		}
		items, _ := body[1].([]any)
		for _, raw := range items {
			item, _ := raw.([]any)
			if len(item) < 4 {
				continue
			}
			kind, _ := item[2].(float64)
			fraction, ok := item[1].(float64)
			if !ok || math.IsNaN(fraction) || fraction < 0 || fraction > 1 {
				continue
			}
			key := ""
			if kind == 1 {
				key = "current_5h"
			} else if kind == 2 {
				key = "weekly"
			}
			if key == "" {
				continue
			}
			row := map[string]any{"usage_level": fraction, "remaining_credits": item[0]}
			outer, _ := item[3].([]any)
			if len(outer) > 0 {
				inner, _ := outer[0].([]any)
				if len(inner) > 0 {
					if seconds, ok := inner[0].(float64); ok {
						row["reset_at"] = time.Unix(int64(seconds), 0).UTC().Format(time.RFC3339)
					}
				}
			}
			usage[key] = row
		}
	}
	return usage, nil
}
