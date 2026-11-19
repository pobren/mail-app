package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/pobren/mail-app/bridge/internal/config"
)

// A mailbox added to the key after connecting is picked up without pressing Save and connect, and one taken
// off the key is dropped.
func TestNewMailboxesArePickedUp(t *testing.T) {
	var mu sync.Mutex
	boxes := []map[string]string{{"id": "a", "email": "one@example.com"}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ext/v1/mailboxes" {
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewEncoder(w).Encode(boxes)
			return
		}
		http.Error(w, `{"error":"not here"}`, http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	settings, err := config.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := settings.Update(func(c *config.Config) { c.Server, c.Key = srv.URL, "mailapp_test" }); err != nil {
		t.Fatal(err)
	}
	old := MailboxCheck
	MailboxCheck = 50 * time.Millisecond
	defer func() { MailboxCheck = old }()

	b := New(settings, t.TempDir())
	defer b.Close()
	if err := b.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	names := func() []string {
		var l []string
		for _, a := range b.Accounts() {
			l = append(l, a.Address)
		}
		sort.Strings(l)
		return l
	}
	wait := func(want ...string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			got := names()
			if len(got) == len(want) && (len(want) == 0 || got[0] == want[0] && got[len(got)-1] == want[len(want)-1]) {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("mailboxes %v, want %v", names(), want)
	}
	wait("one@example.com")

	mu.Lock()
	boxes = append(boxes, map[string]string{"id": "b", "email": "Two@Example.com"})
	mu.Unlock()
	wait("one@example.com", "two@example.com")

	mu.Lock()
	boxes = boxes[1:]
	mu.Unlock()
	wait("two@example.com")
}
