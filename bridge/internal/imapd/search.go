package imapd

// Search and the envelope are adapted from go-imap's imapmemserver (MIT licence, Copyright (c) 2013 The
// Go-IMAP Authors), to read each email's file only when the search needs it.

import (
	"bufio"
	"bytes"
	"io"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	gomessage "github.com/emersion/go-message"
	"github.com/emersion/go-message/mail"
	"github.com/emersion/go-message/textproto"
	"github.com/pobren/mail-app/bridge/internal/store"
)

func envelope(raw []byte) *imap.Envelope {
	h, err := textproto.ReadHeader(bufio.NewReader(bytes.NewReader(raw)))
	if err != nil {
		return nil
	}
	return imapserver.ExtractEnvelope(h)
}

func (s *session) Search(kind imapserver.NumKind, criteria *imap.SearchCriteria, options *imap.SearchOptions) (*imap.SearchData, error) {
	s.acct.Mu.Lock()
	s.staticCriteria(criteria)
	type cand struct {
		seq uint32
		msg store.Msg
	}
	var cands []cand
	for i, m := range s.sel.Msgs {
		cands = append(cands, cand{s.tracker.EncodeSeqNum(uint32(i) + 1), *m})
	}
	s.acct.Mu.Unlock()

	needRaw := criteriaNeedRaw(criteria)
	c, cancel := ctx()
	defer cancel()
	var data imap.SearchData
	var seqSet imap.SeqSet
	var uidSet imap.UIDSet
	for _, cd := range cands {
		var raw []byte
		if needRaw {
			b, err := s.acct.Raw(c, cd.msg.ID)
			if err != nil {
				continue
			}
			raw = b
		}
		if !match(cd.seq, &cd.msg, raw, criteria) {
			continue
		}
		uidSet.AddNum(cd.msg.UID)
		var num uint32
		switch kind {
		case imapserver.NumKindSeq:
			if cd.seq == 0 {
				continue
			}
			seqSet.AddNum(cd.seq)
			num = cd.seq
		case imapserver.NumKindUID:
			num = uint32(cd.msg.UID)
		}
		if data.Min == 0 || num < data.Min {
			data.Min = num
		}
		if num > data.Max {
			data.Max = num
		}
		data.Count++
	}
	if kind == imapserver.NumKindSeq {
		data.All = seqSet
	} else {
		data.All = uidSet
	}
	if options.ReturnSave {
		s.searchRes = uidSet
	}
	return &data, nil
}

func (s *session) staticCriteria(c *imap.SearchCriteria) {
	seqs := make([]imap.SeqSet, 0, len(c.SeqNum))
	for _, set := range c.SeqNum {
		switch n := s.static(set).(type) {
		case imap.SeqSet:
			seqs = append(seqs, n)
		case imap.UIDSet:
			c.UID = append(c.UID, n)
		}
	}
	c.SeqNum = seqs
	for i, set := range c.UID {
		c.UID[i] = s.static(set).(imap.UIDSet)
	}
	for i := range c.Not {
		s.staticCriteria(&c.Not[i])
	}
	for i := range c.Or {
		for j := range c.Or[i] {
			s.staticCriteria(&c.Or[i][j])
		}
	}
}

func criteriaNeedRaw(c *imap.SearchCriteria) bool {
	if len(c.Header) > 0 || len(c.Body) > 0 || len(c.Text) > 0 || c.Larger != 0 || c.Smaller != 0 || !c.SentSince.IsZero() || !c.SentBefore.IsZero() {
		return true
	}
	for i := range c.Not {
		if criteriaNeedRaw(&c.Not[i]) {
			return true
		}
	}
	for i := range c.Or {
		if criteriaNeedRaw(&c.Or[i][0]) || criteriaNeedRaw(&c.Or[i][1]) {
			return true
		}
	}
	return false
}

func hasFlag(m *store.Msg, f imap.Flag) bool {
	for _, x := range m.Flags() {
		if strings.EqualFold(string(x), string(f)) {
			return true
		}
	}
	return false
}

func match(seq uint32, m *store.Msg, raw []byte, c *imap.SearchCriteria) bool {
	for _, set := range c.SeqNum {
		if seq == 0 || !set.Contains(seq) {
			return false
		}
	}
	for _, set := range c.UID {
		if !set.Contains(m.UID) {
			return false
		}
	}
	if !matchDate(m.Date, c.Since, c.Before) {
		return false
	}
	for _, f := range c.Flag {
		if !hasFlag(m, f) {
			return false
		}
	}
	for _, f := range c.NotFlag {
		if hasFlag(m, f) {
			return false
		}
	}
	if c.Larger != 0 && int64(len(raw)) <= c.Larger {
		return false
	}
	if c.Smaller != 0 && int64(len(raw)) >= c.Smaller {
		return false
	}
	if raw != nil {
		entity := func() *gomessage.Entity {
			e, _ := gomessage.Read(bytes.NewReader(raw))
			if e == nil {
				e, _ = gomessage.New(gomessage.Header{}, bytes.NewReader(nil))
			}
			return e
		}
		header := mail.Header{Header: entity().Header}
		for _, fc := range c.Header {
			if !matchFields(header.FieldsByKey(fc.Key), fc.Value) {
				return false
			}
		}
		if !c.SentSince.IsZero() || !c.SentBefore.IsZero() {
			t, err := header.Date()
			if err != nil || !matchDate(t, c.SentSince, c.SentBefore) {
				return false
			}
		}
		for _, t := range c.Text {
			if !matchEntity(entity(), t, true) {
				return false
			}
		}
		for _, b := range c.Body {
			if !matchEntity(entity(), b, false) {
				return false
			}
		}
	}
	for i := range c.Not {
		if match(seq, m, raw, &c.Not[i]) {
			return false
		}
	}
	for i := range c.Or {
		if !match(seq, m, raw, &c.Or[i][0]) && !match(seq, m, raw, &c.Or[i][1]) {
			return false
		}
	}
	return true
}

func matchDate(t, since, before time.Time) bool {
	t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	if !since.IsZero() && t.Before(since) {
		return false
	}
	if !before.IsZero() && !t.Before(before) {
		return false
	}
	return true
}

func matchFields(fields gomessage.HeaderFields, pattern string) bool {
	if pattern == "" {
		return fields.Len() > 0
	}
	pattern = strings.ToLower(pattern)
	for fields.Next() {
		v, _ := fields.Text()
		if strings.Contains(strings.ToLower(v), pattern) {
			return true
		}
	}
	return false
}

func matchEntity(e *gomessage.Entity, pattern string, header bool) bool {
	if pattern == "" {
		return true
	}
	if header && matchFields(e.Header.Fields(), pattern) {
		return true
	}
	if mr := e.MultipartReader(); mr != nil {
		for {
			part, err := mr.NextPart()
			if err != nil {
				return false
			}
			if matchEntity(part, pattern, header) {
				return true
			}
		}
	}
	t, _, err := e.Header.ContentType()
	if err != nil || (!strings.HasPrefix(t, "text/") && !strings.HasPrefix(t, "message/")) {
		return false
	}
	buf, err := io.ReadAll(e.Body)
	if err != nil {
		return false
	}
	return bytes.Contains(bytes.ToLower(buf), bytes.ToLower([]byte(pattern)))
}
