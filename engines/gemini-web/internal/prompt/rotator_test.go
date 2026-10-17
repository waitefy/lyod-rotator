package prompt

import "testing"

func TestRotatorHistoryKeepsPairsAndDocumentBytes(t *testing.T) {
	history := func(id string) []map[string]any {
		return []map[string]any{
			{"role": "assistant", "tool_calls": []any{map[string]any{"id": id, "function": map[string]any{"name": "read", "arguments": "{\"path\":\"x\"}"}}}},
			{"role": "tool", "tool_call_id": id, "name": "read", "content": "result"},
		}
	}
	a, b := history("public-id"), history("engine-id")
	if HashHistoryWithTools("a", "m", a, nil, nil) != HashHistoryWithTools("a", "m", b, nil, nil) {
		t.Fatal("equivalent call pairs missed cache")
	}
	b[1]["tool_call_id"] = "wrong-call"
	if HashHistoryWithTools("a", "m", a, nil, nil) == HashHistoryWithTools("a", "m", b, nil, nil) {
		t.Fatal("mismatched result collided")
	}
	parts := ExtractImageParts([]map[string]any{{"role": "user", "content": []any{map[string]any{"type": "file", "file": map[string]any{"file_data": "data:application/pdf;base64,cGRm"}}}}})
	if len(parts) != 1 || string(parts[0].Data) != "pdf" || parts[0].ContentType != "application/pdf" {
		t.Fatal("document was dropped")
	}
}
