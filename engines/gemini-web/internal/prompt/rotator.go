package prompt

import "fmt"

// The public translators may regenerate call IDs. Canonicalize matched call/result
// pairs by position, preserving orphan IDs and all names, arguments and results.
func canonicalHistory(messages []map[string]any) []map[string]any {
	result := make([]map[string]any, len(messages))
	ids := map[string]string{}
	next := 0
	for i, message := range messages {
		m := make(map[string]any, len(message))
		for key, value := range message {
			m[key] = value
		}
		if calls, ok := message["tool_calls"].([]any); ok {
			copied := make([]any, len(calls))
			for j, raw := range calls {
				call, ok := raw.(map[string]any)
				if !ok {
					copied[j] = raw
					continue
				}
				clone := make(map[string]any, len(call))
				for key, value := range call {
					clone[key] = value
				}
				if id, ok := call["id"].(string); ok && id != "" {
					canonical := fmt.Sprintf("call_%d", next)
					next++
					ids[id] = canonical
					clone["id"] = canonical
				}
				copied[j] = clone
			}
			m["tool_calls"] = copied
		}
		if id, ok := message["tool_call_id"].(string); ok {
			if canonical, exists := ids[id]; exists {
				m["tool_call_id"] = canonical
			}
		}
		result[i] = m
	}
	return result
}
