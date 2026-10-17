package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

type request struct {
	Mode            string         `json:"mode"`
	Prompt          string         `json:"prompt"`
	Output          string         `json:"output"`
	Thinking        string         `json:"thinkingLevel"`
	CookiesFile     string         `json:"cookiesFile"`
	Proxy           string         `json:"proxy"`
	IncludeIdentity bool           `json:"includeIdentity"`
	Request         map[string]any `json:"engineRequest"`
	Attachments     []attachment   `json:"attachments"`
}
type attachment struct {
	MIME string `json:"mimeType"`
	Data string `json:"data"`
}

func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func array(v any) []any           { a, _ := v.([]any); return a }
func text(v any) string           { s, _ := v.(string); return s }

// Keep roles, call IDs, schemas and attachment bytes until the engine boundary.
func chatBody(in request) (map[string]any, error) {
	if in.Thinking != "low" && in.Thinking != "medium" && in.Thinking != "high" {
		return nil, errors.New("invalid thinking level")
	}
	var messages []any
	if sys := object(in.Request["systemInstruction"]); sys != nil {
		var pieces []string
		for _, p := range array(sys["parts"]) {
			pieces = append(pieces, text(object(p)["text"]))
		}
		messages = append(messages, map[string]any{"role": "system", "content": strings.Join(pieces, "\n")})
	}
	var tools []any
	for _, group := range array(in.Request["tools"]) {
		for _, decl := range array(object(group)["functionDeclarations"]) {
			tools = append(tools, map[string]any{"type": "function", "function": decl})
		}
	}
	pending := map[string][]string{}
	callNumber := 0
	for _, value := range array(in.Request["contents"]) {
		turn := object(value)
		role := "user"
		if turn["role"] == "model" {
			role = "assistant"
		}
		var content, calls, results []any
		for _, value := range array(turn["parts"]) {
			part := object(value)
			if s, ok := part["text"].(string); ok {
				content = append(content, map[string]any{"type": "text", "text": s})
			} else if file := object(part["inlineData"]); file != nil {
				mime, data := text(file["mimeType"]), text(file["data"])
				decoded, err := base64.StdEncoding.DecodeString(data)
				if err != nil || len(decoded) > 5*1024*1024 {
					return nil, errors.New("invalid attachment")
				}
				if strings.HasPrefix(mime, "image/") {
					content = append(content, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:" + mime + ";base64," + data}})
				} else {
					content = append(content, map[string]any{"type": "file", "file": map[string]any{"file_data": "data:" + mime + ";base64," + data}})
				}
			} else if call := object(part["functionCall"]); call != nil {
				name := text(call["name"])
				id := text(call["id"])
				if id == "" {
					id = fmt.Sprintf("call_%d", callNumber)
					callNumber++
				}
				pending[name] = append(pending[name], id)
				args, err := json.Marshal(call["args"])
				if err != nil {
					return nil, err
				}
				calls = append(calls, map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": string(args)}})
			} else if result := object(part["functionResponse"]); result != nil {
				name := text(result["name"])
				id := text(result["id"])
				if len(pending[name]) > 0 {
					if id == "" {
						id = pending[name][0]
					}
					pending[name] = pending[name][1:]
				}
				if id == "" {
					return nil, errors.New("orphan tool result")
				}
				data, err := json.Marshal(result["response"])
				if err != nil {
					return nil, err
				}
				results = append(results, map[string]any{"role": "tool", "tool_call_id": id, "name": name, "content": string(data)})
			}
		}
		if len(content) > 0 || len(calls) > 0 {
			m := map[string]any{"role": role, "content": content}
			if len(calls) > 0 {
				m["tool_calls"] = calls
			}
			messages = append(messages, m)
		}
		messages = append(messages, results...)
	}
	if len(messages) == 0 {
		return nil, errors.New("missing messages")
	}
	body := map[string]any{"model": "gemini-argon", "messages": messages, "stream": true, "reasoning_effort": in.Thinking, "temporary": false}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	choice := object(object(in.Request["toolConfig"])["functionCallingConfig"])
	switch choice["mode"] {
	case "NONE":
		body["tool_choice"] = "none"
	case "ANY":
		names := array(choice["allowedFunctionNames"])
		if len(names) == 1 {
			body["tool_choice"] = map[string]any{"type": "function", "function": map[string]any{"name": names[0]}}
		} else if len(names) > 1 {
			var allowed []any
			for _, tool := range tools {
				for _, name := range names {
					if object(object(tool)["function"])["name"] == name {
						allowed = append(allowed, tool)
					}
				}
			}
			body["tools"] = allowed
			body["tool_choice"] = "required"
		} else {
			body["tool_choice"] = "required"
		}
	}
	return body, nil
}
