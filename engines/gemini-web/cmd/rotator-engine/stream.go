package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"
)

func streamChat(body io.Reader) error {
	scanner := bufio.NewScanner(io.LimitReader(body, 16*1024*1024))
	scanner.Buffer(make([]byte, 65536), 1024*1024)
	ready, finished, done := false, false, false
	var citations citationFilter
	writeText := func(s string) {
		if s == "" {
			return
		}
		if !ready {
			emit(map[string]any{"type": "ready"})
			ready = true
		}
		emit(map[string]any{"type": "delta", "text": s})
	}
	calls := map[int]map[string]any{}
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			done = true
			break
		}
		var event map[string]any
		if json.Unmarshal([]byte(data), &event) != nil {
			return errors.New("invalid stream")
		}
		if event["error"] != nil {
			return errors.New("upstream stream error")
		}
		for _, c := range array(event["choices"]) {
			choice := object(c)
			delta := object(choice["delta"])
			if s := text(delta["content"]); s != "" {
				writeText(citations.feed(s, false))
			}
			for _, raw := range array(delta["tool_calls"]) {
				call := object(raw)
				i, _ := call["index"].(float64)
				index := int(i)
				if index < 0 || index > 63 {
					return errors.New("too many tools")
				}
				if calls[index] == nil {
					calls[index] = map[string]any{"name": "", "arguments": ""}
				}
				target := calls[index]
				fn := object(call["function"])
				target["name"] = text(target["name"]) + text(fn["name"])
				target["arguments"] = text(target["arguments"]) + text(fn["arguments"])
				if len(text(target["arguments"])) > 128000 {
					return errors.New("tool output limit")
				}
			}
			if choice["finish_reason"] != nil {
				if choice["finish_reason"] != "stop" && choice["finish_reason"] != "tool_calls" {
					return errors.New("incomplete response")
				}
				finished = true
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if !done || !finished {
		return errors.New("incomplete stream")
	}
	writeText(citations.feed("", true))
	if len(calls) > 0 {
		indices := make([]int, 0, len(calls))
		for i := range calls {
			indices = append(indices, i)
		}
		sort.Ints(indices)
		var result []any
		for _, i := range indices {
			var args map[string]any
			if json.Unmarshal([]byte(text(calls[i]["arguments"])), &args) != nil || args == nil || text(calls[i]["name"]) == "" {
				return errors.New("invalid tool")
			}
			result = append(result, map[string]any{"name": calls[i]["name"], "args": args})
		}
		if !ready {
			emit(map[string]any{"type": "ready"})
			ready = true
		}
		emit(map[string]any{"type": "tools", "calls": result})
	}
	if !ready {
		return errors.New("empty stream")
	}
	emit(map[string]any{"type": "done"})
	return nil
}
