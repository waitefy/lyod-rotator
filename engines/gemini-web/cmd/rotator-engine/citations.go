package main

import (
	"regexp"
	"strings"
)

var unresolvedCitation = regexp.MustCompile(`^\[cite:\s*\d+(?:\s*,\s*\d+)*\]$`)

// Hold only an unfinished bracket, including markers split across SSE chunks.
// Preserve ordinary Markdown links; unresolved numeric markers have no URL.
type citationFilter struct{ pending string }

func (f *citationFilter) feed(s string, final bool) string {
	f.pending += s
	var out strings.Builder
	for len(f.pending) > 0 {
		i := strings.IndexByte(f.pending, '[')
		if i < 0 {
			out.WriteString(f.pending)
			f.pending = ""
			break
		}
		out.WriteString(f.pending[:i])
		f.pending = f.pending[i:]
		j := strings.IndexByte(f.pending, ']')
		if j < 0 {
			if final || len(f.pending) > 128 {
				out.WriteString(f.pending)
				f.pending = ""
			}
			break
		}
		marker := f.pending[:j+1]
		if !unresolvedCitation.MatchString(marker) {
			out.WriteString(marker)
		}
		f.pending = f.pending[j+1:]
	}
	return out.String()
}
