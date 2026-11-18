// Package store keeps the bridge's own picture of each mailbox: its folders, the emails in them with the
// numbers IMAP and POP3 give them, and a cache of each email's file. It keeps in step with Mail App by
// reading the changes feed, and tells open IMAP connections what changed.
package store

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/pobren/mail-app/bridge/internal/api"
)

// Built-in Mail App folders, and how the bridge shows them.
const (
	Inbox   = "inbox"
	Sent    = "sent"
	Drafts  = "draft"
	Archive = "archive"
	Spam    = "spam"
	Bin     = "trash"
)

// Folders Mail App uses for its own features, not shown in Outlook.
var hidden = map[string]bool{"snoozed": true, "scheduled": true}

var builtIn = map[string]struct {
	name string
	attr imap.MailboxAttr
}{
	Inbox:   {"INBOX", ""},
	Sent:    {"Sent", imap.MailboxAttrSent},
	Drafts:  {"Drafts", imap.MailboxAttrDrafts},
	Archive: {"Archive", imap.MailboxAttrArchive},
	Spam:    {"Spam", imap.MailboxAttrJunk},
	Bin:     {"Bin", imap.MailboxAttrTrash},
}

// Msg is one email as IMAP sees it.
type Msg struct {
	UID     imap.UID  `json:"u"`
	ID      string    `json:"id"`
	Seen    bool      `json:"s,omitempty"`
	Flagged bool      `json:"f,omitempty"`
	Date    time.Time `json:"d"`
	// Flags kept only by the bridge: \Answered, \Draft, \Deleted and keywords.
	Local []string `json:"l,omitempty"`
	// MovedAway: IMAP COPY moved it in Mail App, but this folder keeps showing it until the client deletes it
	// (Outlook moves by copying and then deleting). Not saved.
	MovedAway bool `json:"-"`
}

// Flags is the full IMAP flag list.
func (m *Msg) Flags() []imap.Flag {
	var out []imap.Flag
	if m.Seen {
		out = append(out, imap.FlagSeen)
	}
	if m.Flagged {
		out = append(out, imap.FlagFlagged)
	}
	for _, f := range m.Local {
		out = append(out, imap.Flag(f))
	}
	return out
}

// HasLocal says whether a bridge-only flag is set.
func (m *Msg) HasLocal(f imap.Flag) bool {
	for _, x := range m.Local {
		if strings.EqualFold(x, string(f)) {
			return true
		}
	}
	return false
}

func (m *Msg) setLocal(f imap.Flag, on bool) {
	out := m.Local[:0]
	for _, x := range m.Local {
		if !strings.EqualFold(x, string(f)) {
			out = append(out, x)
		}
	}
	if on {
		out = append(out, string(f))
	}
	m.Local = out
}

// Folder is one folder and its emails, in UID order.
type Folder struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	UIDValidity uint32   `json:"uidValidity"`
	UIDNext     imap.UID `json:"uidNext"`
	Msgs        []*Msg   `json:"msgs"`

	tracker *imapserver.MailboxTracker
}

// IMAPName is how the folder is shown to IMAP clients.
func (f *Folder) IMAPName() string {
	if b, ok := builtIn[f.ID]; ok {
		return b.name
	}
	return strings.ReplaceAll(f.Name, "/", "-")
}

// SpecialUse is the folder's IMAP special-use attribute, if it has one.
func (f *Folder) SpecialUse() imap.MailboxAttr {
	return builtIn[f.ID].attr
}

// Tracker sends this folder's changes to open IMAP connections.
func (f *Folder) Tracker() *imapserver.MailboxTracker { return f.tracker }

// Index finds an email by id. -1 when it isn't here.
func (f *Folder) Index(id string) int {
	for i, m := range f.Msgs {
		if m.ID == id {
			return i
		}
	}
	return -1
}

func (f *Folder) add(m *Msg) *Msg {
	m.UID = f.UIDNext
	f.UIDNext++
	f.Msgs = append(f.Msgs, m)
	f.tracker.QueueNumMessages(uint32(len(f.Msgs)))
	return m
}

func (f *Folder) remove(i int) {
	f.Msgs = append(f.Msgs[:i], f.Msgs[i+1:]...)
	f.tracker.QueueExpunge(uint32(i) + 1)
}

func randomUint32() uint32 {
	var b [4]byte
	_, _ = rand.Read(b[:])
	v := binary.BigEndian.Uint32(b[:]) & 0x7fffffff
	if v == 0 {
		v = 1
	}
	return v
}

// Account is one Mail App mailbox, served to Outlook as one account.
type Account struct {
	Address string
	client  *api.Client
	dir     string

	// Mu guards everything below and every Folder's fields.
	Mu      sync.Mutex
	Cursor  int64              `json:"cursor"`
	Folders map[string]*Folder `json:"folders"`
	Ready   bool               `json:"ready"`

	dirty     bool
	poke      chan struct{}
	lastSync  time.Time
	lastError string
	// Mail sent through the bridge's SMTP lately, by Message-ID, so Outlook's copy for Sent isn't added twice.
	recentSent map[string]sentNote
	// Inline fetch of a raw email waits on this when another fetch of it is already running.
	rawLocks map[string]*sync.Mutex
	rawMu    sync.Mutex
}

// New loads (or starts) the bridge's picture of a mailbox, kept in dir.
func New(address string, client *api.Client, dir string) (*Account, error) {
	a := &Account{
		Address: strings.ToLower(address), client: client, dir: dir,
		Folders: map[string]*Folder{}, poke: make(chan struct{}, 1),
		recentSent: map[string]sentNote{}, rawLocks: map[string]*sync.Mutex{},
	}
	if err := os.MkdirAll(filepath.Join(dir, "raw"), 0o700); err != nil {
		return nil, err
	}
	if b, err := os.ReadFile(filepath.Join(dir, "state.json")); err == nil {
		if err := json.Unmarshal(b, a); err != nil {
			log.Printf("%s: saved state unreadable, starting again: %v", address, err)
			a.Folders, a.Cursor, a.Ready = map[string]*Folder{}, 0, false
		}
	}
	for _, f := range a.Folders {
		f.tracker = imapserver.NewMailboxTracker(uint32(len(f.Msgs)))
	}
	return a, nil
}

// Client is the API client the account uses.
func (a *Account) Client() *api.Client { return a.client }

// Status says when the account last kept in step, and the last problem, for the settings page.
func (a *Account) Status() (ready bool, last time.Time, problem string, counts map[string]int) {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	counts = map[string]int{}
	for _, f := range a.Folders {
		if !hidden[f.ID] {
			counts[f.IMAPName()] = len(f.Msgs)
		}
	}
	return a.Ready, a.lastSync, a.lastError, counts
}

// Save writes the picture to disk if it changed.
func (a *Account) Save() error {
	a.Mu.Lock()
	if !a.dirty {
		a.Mu.Unlock()
		return nil
	}
	b, err := json.Marshal(a)
	a.dirty = false
	a.Mu.Unlock()
	if err != nil {
		return err
	}
	tmp := filepath.Join(a.dir, "state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(a.dir, "state.json"))
}

// Poke asks the sync loop to look for changes now, such as after the bridge changed something.
func (a *Account) Poke() {
	select {
	case a.poke <- struct{}{}:
	default:
	}
}

// FolderByIMAPName finds a shown folder by its IMAP name. Call with Mu held.
func (a *Account) FolderByIMAPName(name string) *Folder {
	if strings.EqualFold(name, "INBOX") {
		return a.Folders[Inbox]
	}
	for _, f := range a.Folders {
		if hidden[f.ID] {
			continue
		}
		if f.IMAPName() == name {
			return f
		}
	}
	// Outlook's own names for the special folders.
	alias := map[string]string{"sent items": Sent, "sent messages": Sent, "deleted items": Bin, "trash": Bin, "junk": Spam, "junk email": Spam, "junk e-mail": Spam, "draft": Drafts}
	if id, ok := alias[strings.ToLower(name)]; ok {
		return a.Folders[id]
	}
	return nil
}

// Shown lists the folders IMAP clients see, Inbox first.
func (a *Account) Shown() []*Folder {
	var out []*Folder
	for _, f := range a.Folders {
		if !hidden[f.ID] {
			out = append(out, f)
		}
	}
	order := map[string]int{Inbox: 0, Drafts: 1, Sent: 2, Archive: 3, Spam: 4, Bin: 5}
	sort.Slice(out, func(i, j int) bool {
		oi, iok := order[out[i].ID]
		oj, jok := order[out[j].ID]
		if iok && jok {
			return oi < oj
		}
		if iok != jok {
			return iok
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

// -- Keeping in step -----------------------------------------------------------

// PollEvery is how often the bridge asks Mail App what changed.
var PollEvery = 20 * time.Second

// Run keeps the account in step until ctx ends.
func (a *Account) Run(ctx context.Context) {
	backoff := PollEvery
	for {
		err := a.SyncOnce(ctx)
		a.Mu.Lock()
		if err != nil {
			a.lastError = err.Error()
		} else {
			a.lastError = ""
			a.lastSync = time.Now()
		}
		a.Mu.Unlock()
		if err := a.Save(); err != nil {
			log.Printf("%s: couldn't save: %v", a.Address, err)
		}
		wait := PollEvery
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("%s: %v", a.Address, err)
			backoff = min(backoff*2, 5*time.Minute)
			wait = backoff
		} else {
			backoff = PollEvery
		}
		select {
		case <-ctx.Done():
			return
		case <-a.poke:
		case <-time.After(wait):
		}
	}
}

// SyncOnce reads the folders the first time, then what changed since.
func (a *Account) SyncOnce(ctx context.Context) error {
	a.Mu.Lock()
	ready, cursor := a.Ready, a.Cursor
	a.Mu.Unlock()
	if !ready {
		return a.fullSync(ctx)
	}
	for {
		ch, err := a.client.Changes(ctx, a.Address, cursor)
		if errors.Is(err, api.ErrResync) {
			return a.fullSync(ctx)
		}
		if err != nil {
			return err
		}
		a.Mu.Lock()
		a.applyFolders(ch.Folders)
		for _, c := range ch.Changes {
			a.applyChange(c)
		}
		if ch.Cursor > a.Cursor {
			a.Cursor = ch.Cursor
		}
		cursor = a.Cursor
		a.dirty = true
		a.Mu.Unlock()
		if !ch.More {
			return nil
		}
	}
}

// fullSync reads every folder from the start. Emails the bridge already knows keep their numbers.
func (a *Account) fullSync(ctx context.Context) error {
	first, err := a.client.Changes(ctx, a.Address, -1)
	if err != nil {
		return err
	}
	type listed struct {
		id      string
		entries []api.IndexEntry
	}
	var lists []listed
	for _, f := range first.Folders {
		if hidden[f.ID] {
			continue
		}
		entries, _, err := a.client.Index(ctx, a.Address, f.ID)
		if err != nil {
			return fmt.Errorf("reading %s: %w", f.Name, err)
		}
		lists = append(lists, listed{f.ID, entries})
	}
	a.Mu.Lock()
	defer a.Mu.Unlock()
	a.applyFolders(first.Folders)
	for _, l := range lists {
		f := a.Folders[l.id]
		if f == nil {
			continue
		}
		want := map[string]api.IndexEntry{}
		for _, e := range l.entries {
			want[e.ID] = e
		}
		for i := len(f.Msgs) - 1; i >= 0; i-- {
			m := f.Msgs[i]
			if e, ok := want[m.ID]; ok {
				a.setServerFlags(f, i, e.Read, e.Starred)
				delete(want, m.ID)
			} else {
				f.remove(i)
			}
		}
		for _, e := range l.entries {
			if _, ok := want[e.ID]; ok {
				f.add(&Msg{ID: e.ID, Seen: e.Read, Flagged: e.Starred, Date: parseDate(e.Date)})
			}
		}
	}
	// The cursor from before the folders were read, so nothing that changed meanwhile is missed.
	a.Cursor = first.Cursor
	a.Ready = true
	a.dirty = true
	return nil
}

func parseDate(s *string) time.Time {
	if s == nil {
		return time.Now()
	}
	t, err := time.Parse(time.RFC3339Nano, *s)
	if err != nil {
		return time.Now()
	}
	return t
}

// applyFolders adds new folders, renames changed ones and drops ones that are gone. Mu held.
func (a *Account) applyFolders(list []api.Folder) {
	if len(list) == 0 {
		return
	}
	seen := map[string]bool{}
	for _, f := range list {
		seen[f.ID] = true
		if cur, ok := a.Folders[f.ID]; ok {
			cur.Name = f.Name
			continue
		}
		a.Folders[f.ID] = &Folder{ID: f.ID, Name: f.Name, UIDValidity: randomUint32(), UIDNext: 1, tracker: imapserver.NewMailboxTracker(0)}
	}
	for id := range a.Folders {
		if !seen[id] {
			delete(a.Folders, id)
		}
	}
}

// where finds an email in any folder. Mu held.
func (a *Account) where(id string) (*Folder, int) {
	for _, f := range a.Folders {
		if i := f.Index(id); i >= 0 && !f.Msgs[i].MovedAway {
			return f, i
		}
	}
	return nil, -1
}

// applyChange takes in one change from the feed. Mu held.
func (a *Account) applyChange(c api.Change) {
	// Copies left showing in other folders (IMAP COPY) go once the email is somewhere else for sure.
	for _, f := range a.Folders {
		if i := f.Index(c.ID); i >= 0 && f.Msgs[i].MovedAway && (c.Folder == nil || *c.Folder != f.ID) {
			f.remove(i)
		}
	}
	f, i := a.where(c.ID)
	if c.Deleted || c.Folder == nil {
		if f != nil {
			f.remove(i)
		}
		return
	}
	dest := a.Folders[*c.Folder]
	if f != nil && f == dest {
		a.setServerFlags(f, i, c.Read, c.Starred)
		return
	}
	var keep *Msg
	if f != nil {
		keep = f.Msgs[i]
		f.remove(i)
	}
	if dest == nil || hidden[dest.ID] {
		return
	}
	m := &Msg{ID: c.ID, Seen: c.Read, Flagged: c.Starred, Date: time.Now()}
	if keep != nil {
		m.Date, m.Local = keep.Date, keep.Local
		m.setLocal(imap.FlagDeleted, false)
	}
	dest.add(m)
}

// setServerFlags updates read and starred from Mail App, telling IMAP connections. Mu held.
func (a *Account) setServerFlags(f *Folder, i int, read, starred bool) {
	m := f.Msgs[i]
	if m.Seen == read && m.Flagged == starred {
		return
	}
	m.Seen, m.Flagged = read, starred
	f.tracker.QueueMessageFlags(uint32(i)+1, m.UID, m.Flags(), nil)
}

// -- Changes made from Outlook ------------------------------------------------------

// SetFlags changes an email's flags as an IMAP client asked. Read and starred go to Mail App; the rest stay
// in the bridge. source is the connection that asked, which doesn't need telling.
func (a *Account) SetFlags(ctx context.Context, f *Folder, uid imap.UID, op imap.StoreFlagsOp, flags []imap.Flag, source *imapserver.SessionTracker) error {
	a.Mu.Lock()
	i := -1
	for j, m := range f.Msgs {
		if m.UID == uid {
			i = j
			break
		}
	}
	if i < 0 {
		a.Mu.Unlock()
		return nil
	}
	m := f.Msgs[i]
	seen, flagged := m.Seen, m.Flagged
	has := func(x imap.Flag) bool {
		for _, f := range flags {
			if strings.EqualFold(string(f), string(x)) {
				return true
			}
		}
		return false
	}
	switch op {
	case imap.StoreFlagsSet:
		seen, flagged = has(imap.FlagSeen), has(imap.FlagFlagged)
		m.Local = nil
		for _, fl := range flags {
			if !strings.EqualFold(string(fl), string(imap.FlagSeen)) && !strings.EqualFold(string(fl), string(imap.FlagFlagged)) && fl != flagRecent {
				m.setLocal(fl, true)
			}
		}
	case imap.StoreFlagsAdd, imap.StoreFlagsDel:
		on := op == imap.StoreFlagsAdd
		for _, fl := range flags {
			switch {
			case strings.EqualFold(string(fl), string(imap.FlagSeen)):
				seen = on
			case strings.EqualFold(string(fl), string(imap.FlagFlagged)):
				flagged = on
			case fl == flagRecent:
			default:
				m.setLocal(fl, on)
			}
		}
	}
	id := m.ID
	changeRead, changeStar := seen != m.Seen, flagged != m.Flagged
	m.Seen, m.Flagged = seen, flagged
	f.tracker.QueueMessageFlags(uint32(i)+1, m.UID, m.Flags(), source)
	a.dirty = true
	a.Mu.Unlock()
	if !changeRead && !changeStar {
		return nil
	}
	var r, s *bool
	if changeRead {
		r = &seen
	}
	if changeStar {
		s = &flagged
	}
	if err := a.client.SetFlags(ctx, a.Address, id, r, s); err != nil && api.StatusOf(err) != 404 {
		return err
	}
	return nil
}

// Move moves emails to another folder in Mail App and in the bridge. Answers the old and new UIDs.
// keepShowing leaves them showing in the source folder (for IMAP COPY) until the client deletes them.
func (a *Account) Move(ctx context.Context, src, dest *Folder, uids []imap.UID, keepShowing bool) (from, to []imap.UID, err error) {
	for _, uid := range uids {
		a.Mu.Lock()
		i := -1
		for j, m := range src.Msgs {
			if m.UID == uid {
				i = j
				break
			}
		}
		if i < 0 {
			a.Mu.Unlock()
			continue
		}
		m := src.Msgs[i]
		id := m.ID
		a.Mu.Unlock()
		if err := a.client.Move(ctx, a.Address, id, dest.ID); err != nil {
			if api.StatusOf(err) == 404 {
				continue
			}
			return from, to, err
		}
		a.Mu.Lock()
		if i = src.Index(id); i >= 0 {
			m = src.Msgs[i]
			if keepShowing {
				m.MovedAway = true
			} else {
				src.remove(i)
			}
			nm := dest.add(&Msg{ID: id, Seen: m.Seen, Flagged: m.Flagged, Date: m.Date, Local: append([]string(nil), m.Local...)})
			nm.setLocal(imap.FlagDeleted, false)
			from, to = append(from, uid), append(to, nm.UID)
		}
		a.dirty = true
		a.Mu.Unlock()
	}
	return from, to, nil
}

// ErrNoDelete means the API key can't delete email for good.
var ErrNoDelete = errors.New("this API key can't delete email for good: tick Delete when making the key in Mail App")

// Expunge removes the emails marked \Deleted (only those in uids, if given). Emails in the Bin, Spam and
// Drafts are deleted for good (Drafts first goes to the Bin, as Mail App only deletes from there); from
// anywhere else they go to the Bin. Emails already moved away by COPY just stop showing here.
func (a *Account) Expunge(ctx context.Context, f *Folder, uids *imap.UIDSet) error {
	a.Mu.Lock()
	type doomed struct {
		id    string
		moved bool
	}
	var list []doomed
	for _, m := range f.Msgs {
		if (uids == nil || uids.Contains(m.UID)) && m.HasLocal(imap.FlagDeleted) {
			list = append(list, doomed{m.ID, m.MovedAway})
		}
	}
	a.Mu.Unlock()
	var firstErr error
	for _, d := range list {
		if !d.moved {
			var err error
			switch f.ID {
			case Bin, Spam:
				err = a.client.Delete(ctx, a.Address, d.id)
			case Drafts:
				if err = a.client.Move(ctx, a.Address, d.id, Bin); err == nil {
					err = a.client.Delete(ctx, a.Address, d.id)
				}
			default:
				err = a.client.Move(ctx, a.Address, d.id, Bin)
				if err == nil {
					a.Mu.Lock()
					if bin := a.Folders[Bin]; bin != nil && bin.Index(d.id) < 0 {
						if i := f.Index(d.id); i >= 0 {
							m := f.Msgs[i]
							bin.add(&Msg{ID: d.id, Seen: m.Seen, Flagged: m.Flagged, Date: m.Date})
						}
					}
					a.Mu.Unlock()
				}
			}
			if code := api.StatusOf(err); err != nil && code != 404 {
				if code == 403 {
					err = ErrNoDelete
				}
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
		}
		a.Mu.Lock()
		if i := f.Index(d.id); i >= 0 {
			f.remove(i)
		}
		a.dirty = true
		a.Mu.Unlock()
	}
	a.Poke()
	return firstErr
}

// Append adds an email file to a folder. Outlook's copy of mail it just sent through the bridge isn't added
// to Sent again, as Mail App already put it there: the answer is that copy's UID (or 0 if it isn't there yet).
func (a *Account) Append(ctx context.Context, f *Folder, raw []byte, flags []imap.Flag, date time.Time) (imap.UID, error) {
	if f.ID == Sent {
		if mid := messageID(raw); mid != "" {
			if id, ok := a.SentLately(mid); ok {
				// Mail App already has it in Sent: answer that copy, once the bridge has caught up with it.
				_ = a.SyncOnce(ctx)
				a.Mu.Lock()
				defer a.Mu.Unlock()
				if i := f.Index(id); i >= 0 {
					return f.Msgs[i].UID, nil
				}
				return 0, nil
			}
		}
	}
	seen, flagged := false, false
	var local []string
	for _, fl := range flags {
		switch {
		case strings.EqualFold(string(fl), string(imap.FlagSeen)):
			seen = true
		case strings.EqualFold(string(fl), string(imap.FlagFlagged)):
			flagged = true
		case fl == flagRecent:
		default:
			local = append(local, string(fl))
		}
	}
	id, err := a.client.Append(ctx, a.Address, f.ID, raw, seen, flagged)
	if err != nil {
		return 0, err
	}
	_ = a.writeRaw(id, raw)
	a.Mu.Lock()
	defer a.Mu.Unlock()
	if date.IsZero() {
		date = time.Now()
	}
	if i := f.Index(id); i >= 0 {
		return f.Msgs[i].UID, nil
	}
	m := f.add(&Msg{ID: id, Seen: seen, Flagged: flagged, Date: date, Local: local})
	a.dirty = true
	return m.UID, nil
}

type sentNote struct {
	id string // the email's id in Mail App
	at time.Time
}

// NoteSent remembers mail sent through the bridge: its Message-ID and its id in Mail App.
func (a *Account) NoteSent(messageID, id string) {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	now := time.Now()
	for k, n := range a.recentSent {
		if now.Sub(n.at) > time.Hour {
			delete(a.recentSent, k)
		}
	}
	a.recentSent[strings.Trim(messageID, "<> ")] = sentNote{id, now}
	a.Poke()
}

// SentLately answers the Mail App id of mail with this Message-ID that went out through the bridge in the
// last hour, or "".
func (a *Account) SentLately(messageID string) (string, bool) {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	n, ok := a.recentSent[strings.Trim(messageID, "<> ")]
	if !ok || time.Since(n.at) > time.Hour {
		return "", false
	}
	return n.id, true
}

// CreateFolder adds a folder in Mail App.
func (a *Account) CreateFolder(ctx context.Context, name string) error {
	made, err := a.client.CreateFolder(ctx, a.Address, name)
	if err != nil {
		return err
	}
	a.Mu.Lock()
	a.applyFolders(append(a.folderList(), api.Folder{ID: made.ID, Name: made.Name}))
	a.dirty = true
	a.Mu.Unlock()
	return nil
}

// RenameFolder renames a folder in Mail App. Built-in folders can't be renamed.
func (a *Account) RenameFolder(ctx context.Context, f *Folder, name string) error {
	if _, ok := builtIn[f.ID]; ok {
		return errors.New("Mail App's own folders can't be renamed")
	}
	if err := a.client.RenameFolder(ctx, a.Address, f.ID, name); err != nil {
		return err
	}
	a.Mu.Lock()
	f.Name = name
	a.dirty = true
	a.Mu.Unlock()
	return nil
}

func (a *Account) folderList() []api.Folder {
	var out []api.Folder
	for _, f := range a.Folders {
		out = append(out, api.Folder{ID: f.ID, Name: f.Name})
	}
	return out
}

// flagRecent is IMAP4rev1's \Recent, which clients can't set.
const flagRecent = imap.Flag("\\Recent")
