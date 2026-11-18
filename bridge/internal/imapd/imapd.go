// Package imapd serves the bridge's mailboxes to Outlook over IMAP, on this computer only.
package imapd

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/pobren/mail-app/bridge/internal/store"
)

// Accounts finds the account for a sign-in, or nil when the name or password is wrong.
type Accounts func(username, password string) *store.Account

// Serve answers IMAP on the listener until it's closed.
func Serve(ln net.Listener, accounts Accounts, debug io.Writer) error {
	srv := imapserver.New(&imapserver.Options{
		NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return &session{accounts: accounts}, nil, nil
		},
		Caps: imap.CapSet{
			imap.CapIMAP4rev1: {}, imap.CapUIDPlus: {}, imap.CapMove: {}, imap.CapSpecialUse: {},
			imap.CapIdle: {}, imap.CapNamespace: {}, imap.CapLiteralPlus: {}, imap.CapUnselect: {},
		},
		// Only this computer can connect (see main), so passwords can go without TLS, as Outlook allows.
		InsecureAuth: true,
		DebugWriter:  debug,
		Logger:       log.Default(),
	})
	return srv.Serve(ln)
}

const delim = '/'

type session struct {
	accounts Accounts
	acct     *store.Account
	sel      *store.Folder
	tracker  *imapserver.SessionTracker
	// UIDs of the last SEARCH ... SAVE.
	searchRes imap.UIDSet
}

var _ imapserver.SessionMove = (*session)(nil)
var _ imapserver.SessionNamespace = (*session)(nil)

func ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 2*time.Minute)
}

func no(text string) error {
	return &imap.Error{Type: imap.StatusResponseTypeNo, Text: text}
}

var errNoMailbox = &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeNonExistent, Text: "No such folder"}

func (s *session) Close() error {
	if s.tracker != nil {
		s.tracker.Close()
	}
	return nil
}

func (s *session) Login(username, password string) error {
	a := s.accounts(username, password)
	if a == nil {
		return imapserver.ErrAuthFailed
	}
	s.acct = a
	return nil
}

func (s *session) folder(name string) *store.Folder {
	s.acct.Mu.Lock()
	defer s.acct.Mu.Unlock()
	return s.acct.FolderByIMAPName(name)
}

func (s *session) Namespace() (*imap.NamespaceData, error) {
	return &imap.NamespaceData{Personal: []imap.NamespaceDescriptor{{Delim: delim}}}, nil
}

func (s *session) Select(name string, options *imap.SelectOptions) (*imap.SelectData, error) {
	f := s.folder(name)
	if f == nil {
		return nil, errNoMailbox
	}
	if s.tracker != nil {
		s.tracker.Close()
	}
	s.acct.Mu.Lock()
	defer s.acct.Mu.Unlock()
	s.sel = f
	s.tracker = f.Tracker().NewSession()
	var first uint32
	for i, m := range f.Msgs {
		if !m.Seen {
			first = uint32(i) + 1
			break
		}
	}
	flags := []imap.Flag{imap.FlagSeen, imap.FlagAnswered, imap.FlagFlagged, imap.FlagDeleted, imap.FlagDraft}
	return &imap.SelectData{
		Flags: flags, PermanentFlags: append(append([]imap.Flag{}, flags...), imap.FlagWildcard),
		NumMessages: uint32(len(f.Msgs)), FirstUnseenSeqNum: first,
		UIDNext: f.UIDNext, UIDValidity: f.UIDValidity,
	}, nil
}

func (s *session) Unselect() error {
	if s.tracker != nil {
		s.tracker.Close()
	}
	s.sel, s.tracker = nil, nil
	return nil
}

func (s *session) Create(name string, _ *imap.CreateOptions) error {
	name = strings.TrimSuffix(name, string(delim))
	if s.folder(name) != nil {
		return &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeAlreadyExists, Text: "That folder is already there"}
	}
	c, cancel := ctx()
	defer cancel()
	if err := s.acct.CreateFolder(c, name); err != nil {
		return no(err.Error())
	}
	return nil
}

func (s *session) Delete(name string) error {
	return no("Folders can only be deleted in Mail App, so nothing is lost by mistake.")
}

func (s *session) Rename(oldName, newName string, _ *imap.RenameOptions) error {
	f := s.folder(oldName)
	if f == nil {
		return errNoMailbox
	}
	c, cancel := ctx()
	defer cancel()
	if err := s.acct.RenameFolder(c, f, newName); err != nil {
		return no(err.Error())
	}
	return nil
}

func (s *session) Subscribe(string) error   { return nil }
func (s *session) Unsubscribe(string) error { return nil }

func (s *session) List(w *imapserver.ListWriter, ref string, patterns []string, options *imap.ListOptions) error {
	if len(patterns) == 0 {
		return w.WriteList(&imap.ListData{Attrs: []imap.MailboxAttr{imap.MailboxAttrNoSelect}, Delim: delim})
	}
	s.acct.Mu.Lock()
	folders := s.acct.Shown()
	type item struct {
		name string
		attr imap.MailboxAttr
		f    *store.Folder
	}
	var items []item
	for _, f := range folders {
		items = append(items, item{f.IMAPName(), f.SpecialUse(), f})
	}
	s.acct.Mu.Unlock()
	for _, it := range items {
		match := false
		for _, p := range patterns {
			if imapserver.MatchList(it.name, delim, ref, p) {
				match = true
				break
			}
		}
		if !match {
			continue
		}
		if options.SelectSpecialUse && it.attr == "" {
			continue
		}
		data := &imap.ListData{Mailbox: it.name, Delim: delim, Attrs: []imap.MailboxAttr{imap.MailboxAttrSubscribed, imap.MailboxAttrHasNoChildren}}
		if it.attr != "" {
			data.Attrs = append(data.Attrs, it.attr)
		}
		if options.ReturnStatus != nil {
			data.Status = s.status(it.f, options.ReturnStatus)
		}
		if err := w.WriteList(data); err != nil {
			return err
		}
	}
	return nil
}

func (s *session) status(f *store.Folder, options *imap.StatusOptions) *imap.StatusData {
	s.acct.Mu.Lock()
	defer s.acct.Mu.Unlock()
	data := &imap.StatusData{Mailbox: f.IMAPName()}
	n := uint32(len(f.Msgs))
	if options.NumMessages {
		data.NumMessages = &n
	}
	if options.UIDNext {
		data.UIDNext = f.UIDNext
	}
	if options.UIDValidity {
		data.UIDValidity = f.UIDValidity
	}
	if options.NumUnseen {
		var u uint32
		for _, m := range f.Msgs {
			if !m.Seen {
				u++
			}
		}
		data.NumUnseen = &u
	}
	if options.NumDeleted {
		var d uint32
		for _, m := range f.Msgs {
			if m.HasLocal(imap.FlagDeleted) {
				d++
			}
		}
		data.NumDeleted = &d
	}
	if options.NumRecent {
		var z uint32
		data.NumRecent = &z
	}
	if options.Size {
		var size int64
		for _, m := range f.Msgs {
			if n := s.acct.CachedSize(m.ID); n > 0 {
				size += n
			}
		}
		data.Size = &size
	}
	return data
}

func (s *session) Status(name string, options *imap.StatusOptions) (*imap.StatusData, error) {
	f := s.folder(name)
	if f == nil {
		return nil, errNoMailbox
	}
	return s.status(f, options), nil
}

func (s *session) Append(name string, r imap.LiteralReader, options *imap.AppendOptions) (*imap.AppendData, error) {
	f := s.folder(name)
	if f == nil {
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeTryCreate, Text: "No such folder"}
	}
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(r); err != nil {
		return nil, err
	}
	c, cancel := ctx()
	defer cancel()
	uid, err := s.acct.Append(c, f, buf.Bytes(), options.Flags, options.Time)
	if err != nil {
		return nil, no("Mail App couldn't add it: " + err.Error())
	}
	if uid == 0 {
		return nil, nil // done, but there's no UID to give yet
	}
	s.acct.Mu.Lock()
	v := f.UIDValidity
	s.acct.Mu.Unlock()
	return &imap.AppendData{UIDValidity: v, UID: uid}, nil
}

func (s *session) Poll(w *imapserver.UpdateWriter, allowExpunge bool) error {
	if s.tracker == nil {
		return nil
	}
	return s.tracker.Poll(w, allowExpunge)
}

func (s *session) Idle(w *imapserver.UpdateWriter, stop <-chan struct{}) error {
	if s.tracker == nil {
		<-stop
		return nil
	}
	// Ask Mail App straight away, so Outlook gets new mail without waiting for the next round.
	s.acct.Poke()
	return s.tracker.Idle(w, stop)
}

func (s *session) Expunge(w *imapserver.ExpungeWriter, uids *imap.UIDSet) error {
	c, cancel := ctx()
	defer cancel()
	if err := s.acct.Expunge(c, s.sel, uids); err != nil {
		if errors.Is(err, store.ErrNoDelete) {
			return no(err.Error())
		}
		return no("Mail App couldn't delete it: " + err.Error())
	}
	return nil
}

// -- Picking messages -------------------------------------------------------------

type picked struct {
	seq uint32 // as the client knows it
	msg store.Msg
}

// pick lists the messages a sequence set or UID set names. Mu held.
func (s *session) pickLocked(numSet imap.NumSet) []picked {
	numSet = s.static(numSet)
	var out []picked
	for i, m := range s.sel.Msgs {
		seq := s.tracker.EncodeSeqNum(uint32(i) + 1)
		var ok bool
		switch set := numSet.(type) {
		case imap.SeqSet:
			ok = seq != 0 && set.Contains(seq)
		case imap.UIDSet:
			ok = set.Contains(m.UID)
		}
		if ok {
			out = append(out, picked{seq, *m})
		}
	}
	return out
}

func (s *session) pick(numSet imap.NumSet) []picked {
	s.acct.Mu.Lock()
	defer s.acct.Mu.Unlock()
	return s.pickLocked(numSet)
}

// static turns "*" into real numbers, and "$" into the saved search. Mu held.
func (s *session) static(numSet imap.NumSet) imap.NumSet {
	if imap.IsSearchRes(numSet) {
		return s.searchRes
	}
	switch set := numSet.(type) {
	case imap.SeqSet:
		max := uint32(len(s.sel.Msgs))
		out := make(imap.SeqSet, len(set))
		copy(out, set)
		for i := range out {
			fix(&out[i].Start, &out[i].Stop, max)
		}
		return out
	case imap.UIDSet:
		max := uint32(s.sel.UIDNext) - 1
		out := make(imap.UIDSet, len(set))
		copy(out, set)
		for i := range out {
			fix((*uint32)(&out[i].Start), (*uint32)(&out[i].Stop), max)
		}
		return out
	}
	return numSet
}

func fix(start, stop *uint32, max uint32) {
	dyn := false
	if *start == 0 {
		*start, dyn = max, true
	}
	if *stop == 0 {
		*stop, dyn = max, true
	}
	if dyn && *start > *stop {
		*start, *stop = *stop, *start
	}
}

// -- Fetch, store, copy and move ----------------------------------------------------

func needsRaw(o *imap.FetchOptions) bool {
	return o.RFC822Size || o.Envelope || o.BodyStructure != nil || len(o.BodySection) > 0 || len(o.BinarySection) > 0 || len(o.BinarySectionSize) > 0
}

func (s *session) Fetch(w *imapserver.FetchWriter, numSet imap.NumSet, options *imap.FetchOptions) error {
	list := s.pick(numSet)
	markSeen := false
	for _, bs := range options.BodySection {
		if !bs.Peek {
			markSeen = true
		}
	}
	// Download the emails' files a few at a time, ahead of writing them out in order.
	raws := make([][]byte, len(list))
	errs := make([]error, len(list))
	if needsRaw(options) {
		c, cancel := ctx()
		defer cancel()
		var wg sync.WaitGroup
		sem := make(chan struct{}, 6)
		for i := range list {
			wg.Add(1)
			sem <- struct{}{}
			go func(i int) {
				defer wg.Done()
				defer func() { <-sem }()
				raws[i], errs[i] = s.acct.Raw(c, list[i].msg.ID)
			}(i)
		}
		wg.Wait()
	}
	for i, p := range list {
		if errs[i] != nil {
			log.Printf("%s: couldn't download %s: %v", s.acct.Address, p.msg.ID, errs[i])
			continue
		}
		if markSeen && !p.msg.Seen {
			c, cancel := ctx()
			if err := s.acct.SetFlags(c, s.sel, p.msg.UID, imap.StoreFlagsAdd, []imap.Flag{imap.FlagSeen}, s.tracker); err == nil {
				p.msg.Seen = true
			}
			cancel()
		}
		if err := writeMessage(w.CreateMessage(p.seq), &p.msg, raws[i], options); err != nil {
			return err
		}
	}
	return nil
}

func writeMessage(w *imapserver.FetchResponseWriter, m *store.Msg, raw []byte, o *imap.FetchOptions) error {
	w.WriteUID(m.UID)
	if o.Flags {
		w.WriteFlags(m.Flags())
	}
	if o.InternalDate {
		w.WriteInternalDate(m.Date)
	}
	if o.RFC822Size {
		w.WriteRFC822Size(int64(len(raw)))
	}
	if o.Envelope {
		w.WriteEnvelope(envelope(raw))
	}
	if o.BodyStructure != nil {
		w.WriteBodyStructure(imapserver.ExtractBodyStructure(bytes.NewReader(raw)))
	}
	for _, bs := range o.BodySection {
		buf := imapserver.ExtractBodySection(bytes.NewReader(raw), bs)
		wc := w.WriteBodySection(bs, int64(len(buf)))
		_, werr := wc.Write(buf)
		cerr := wc.Close()
		if werr != nil {
			return werr
		}
		if cerr != nil {
			return cerr
		}
	}
	for _, bs := range o.BinarySection {
		buf := imapserver.ExtractBinarySection(bytes.NewReader(raw), bs)
		wc := w.WriteBinarySection(bs, int64(len(buf)))
		_, werr := wc.Write(buf)
		cerr := wc.Close()
		if werr != nil {
			return werr
		}
		if cerr != nil {
			return cerr
		}
	}
	for _, bss := range o.BinarySectionSize {
		w.WriteBinarySectionSize(bss, imapserver.ExtractBinarySectionSize(bytes.NewReader(raw), bss))
	}
	return w.Close()
}

func (s *session) Store(w *imapserver.FetchWriter, numSet imap.NumSet, flags *imap.StoreFlags, options *imap.StoreOptions) error {
	list := s.pick(numSet)
	c, cancel := ctx()
	defer cancel()
	for _, p := range list {
		if err := s.acct.SetFlags(c, s.sel, p.msg.UID, flags.Op, flags.Flags, s.tracker); err != nil {
			return no("Mail App couldn't change it: " + err.Error())
		}
	}
	if flags.Silent {
		return nil
	}
	return s.Fetch(w, numSet, &imap.FetchOptions{Flags: true, UID: true})
}

func (s *session) Copy(numSet imap.NumSet, dest string) (*imap.CopyData, error) {
	d := s.folder(dest)
	if d == nil {
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeTryCreate, Text: "No such folder"}
	}
	if d == s.sel {
		return nil, no("That's the folder it's already in")
	}
	var uids []imap.UID
	for _, p := range s.pick(numSet) {
		uids = append(uids, p.msg.UID)
	}
	c, cancel := ctx()
	defer cancel()
	// Mail App keeps each email in one folder, and Outlook moves mail by copying it and then deleting the
	// original. So a copy moves it in Mail App, and the original keeps showing here until Outlook deletes it.
	from, to, err := s.acct.Move(c, s.sel, d, uids, true)
	if err != nil {
		return nil, no("Mail App couldn't move it: " + err.Error())
	}
	s.acct.Mu.Lock()
	v := d.UIDValidity
	s.acct.Mu.Unlock()
	return &imap.CopyData{UIDValidity: v, SourceUIDs: imap.UIDSetNum(from...), DestUIDs: imap.UIDSetNum(to...)}, nil
}

func (s *session) Move(w *imapserver.MoveWriter, numSet imap.NumSet, dest string) error {
	d := s.folder(dest)
	if d == nil {
		return &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeTryCreate, Text: "No such folder"}
	}
	if d == s.sel {
		return no("That's the folder it's already in")
	}
	var uids []imap.UID
	for _, p := range s.pick(numSet) {
		uids = append(uids, p.msg.UID)
	}
	c, cancel := ctx()
	defer cancel()
	from, to, err := s.acct.Move(c, s.sel, d, uids, false)
	if len(from) > 0 {
		s.acct.Mu.Lock()
		v := d.UIDValidity
		s.acct.Mu.Unlock()
		if werr := w.WriteCopyData(&imap.CopyData{UIDValidity: v, SourceUIDs: imap.UIDSetNum(from...), DestUIDs: imap.UIDSetNum(to...)}); werr != nil {
			return werr
		}
	}
	if err != nil {
		return no("Mail App couldn't move it: " + err.Error())
	}
	return nil
}
