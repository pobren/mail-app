package store

import (
	"testing"

	"github.com/emersion/go-imap/v2"
	"github.com/pobren/mail-app/bridge/internal/api"
)

func str(s string) *string { return &s }

func TestChangesMoveAndDelete(t *testing.T) {
	a, err := New("me@example.com", nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a.applyFolders([]api.Folder{{ID: Inbox, Name: "Inbox"}, {ID: Archive, Name: "Archive"}, {ID: "snoozed", Name: "Snoozed"}})
	a.applyChange(api.Change{ID: "e1", Folder: str(Inbox)})
	a.applyChange(api.Change{ID: "e2", Folder: str(Inbox), Read: true})
	in, ar := a.Folders[Inbox], a.Folders[Archive]
	if len(in.Msgs) != 2 || in.Msgs[0].UID != 1 || in.Msgs[1].UID != 2 || !in.Msgs[1].Seen {
		t.Fatalf("inbox %+v", in.Msgs)
	}
	// Moved in Mail App: leaves the Inbox, gets a new UID in Archive.
	a.applyChange(api.Change{ID: "e1", Folder: str(Archive), Starred: true})
	if len(in.Msgs) != 1 || len(ar.Msgs) != 1 || ar.Msgs[0].UID != 1 || !ar.Msgs[0].Flagged {
		t.Fatalf("after move: inbox %+v archive %+v", in.Msgs, ar.Msgs)
	}
	// Moved back: a new, higher UID, never reused.
	a.applyChange(api.Change{ID: "e1", Folder: str(Inbox)})
	if in.Msgs[len(in.Msgs)-1].UID != 3 {
		t.Fatalf("uid reused: %+v", in.Msgs)
	}
	// Snoozed is hidden from Outlook, so it just leaves the Inbox.
	a.applyChange(api.Change{ID: "e2", Folder: str("snoozed")})
	if len(in.Msgs) != 1 {
		t.Fatalf("snoozed still showing: %+v", in.Msgs)
	}
	a.applyChange(api.Change{ID: "e1", Deleted: true})
	if len(in.Msgs) != 0 {
		t.Fatalf("deleted still showing: %+v", in.Msgs)
	}
}

func TestCopyKeepsShowingUntilElsewhere(t *testing.T) {
	a, _ := New("me@example.com", nil, t.TempDir())
	a.applyFolders([]api.Folder{{ID: Inbox, Name: "Inbox"}, {ID: Archive, Name: "Archive"}})
	a.applyChange(api.Change{ID: "e1", Folder: str(Inbox)})
	in := a.Folders[Inbox]
	in.Msgs[0].MovedAway = true
	a.Folders[Archive].add(&Msg{ID: "e1"})
	a.applyChange(api.Change{ID: "e1", Folder: str(Archive)})
	if len(in.Msgs) != 0 || len(a.Folders[Archive].Msgs) != 1 {
		t.Fatalf("inbox %+v archive %+v", in.Msgs, a.Folders[Archive].Msgs)
	}
}

func TestLocalFlags(t *testing.T) {
	m := &Msg{}
	m.setLocal(imap.FlagDeleted, true)
	m.setLocal(imap.FlagAnswered, true)
	if !m.HasLocal(imap.FlagDeleted) {
		t.Fatal("deleted not set")
	}
	m.setLocal(imap.FlagDeleted, false)
	if m.HasLocal(imap.FlagDeleted) || !m.HasLocal(imap.FlagAnswered) {
		t.Fatalf("flags %v", m.Local)
	}
}
