package gemini

import "testing"

func TestRotatorConflictingIDCannotBeRescuedByLabel(t *testing.T) {
	m := ModelInfo{ModelID: "argon-id", ModelName: "gemini-argon", DisplayName: "Argon"}
	if IsMatchingServedModel(m, "flash-id", "Argon") {
		t.Fatal("conflicting ID accepted via label")
	}
	if !IsMatchingServedModel(m, "argon-id", "Argon") {
		t.Fatal("matching ID rejected")
	}
}
