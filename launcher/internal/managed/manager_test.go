package managed

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type fakeRunner struct {
	version, dep string
	fail         bool
	npmCalls     int
}

func (r *fakeRunner) NPM(_ context.Context, dir string, args ...string) ([]byte, error) {
	r.npmCalls++
	switch args[0] {
	case "view":
		return json.Marshal(r.version)
	case "ci":
		if r.fail {
			return nil, errors.New("simulated failure")
		}
		return nil, nil
	case "install", "update":
		raw, e := os.ReadFile(filepath.Join(dir, "package.json"))
		if e != nil {
			return nil, e
		}
		var p struct{ Dependencies map[string]string }
		if e = json.Unmarshal(raw, &p); e != nil {
			return nil, e
		}
		r.version = p.Dependencies[App]
		l := lockFile{3, map[string]lockEntry{"": {Dependencies: p.Dependencies}, "node_modules/" + App: {Version: r.version}, "node_modules/resource": {Version: r.dep}}}
		return nil, writeJSON(filepath.Join(dir, "package-lock.json"), l)
	}
	return nil, errors.New("unexpected npm command")
}
func (r *fakeRunner) CLI(_ context.Context, dir string, args ...string) ([]byte, error) {
	raw, e := os.ReadFile(filepath.Join(dir, "package-lock.json"))
	if e != nil {
		return nil, e
	}
	var l lockFile
	_ = json.Unmarshal(raw, &l)
	v := l.Packages["node_modules/"+App].Version
	if args[0] == "--version" {
		return []byte(v + "\n"), nil
	}
	return json.Marshal(Info{1, v, true, []Component{{Name: "Resource", Required: true, Status: "ready", Version: l.Packages["node_modules/resource"].Version}, {Name: "Optional", Status: "not-installed"}}})
}
func TestTransactionAndOfflineRollback(t *testing.T) {
	ctx := context.Background()
	r := &fakeRunner{version: "0.2.8", dep: "0.6.9"}
	m := Manager{t.TempDir(), "latest", r}
	c, e := m.Plan(ctx, r.version)
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	if _, e = c.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	first, _ := m.State()
	r.dep = "0.6.10"
	c2, e := m.Plan(ctx, r.version)
	if e != nil {
		t.Fatal(e)
	}
	defer c2.Close()
	if len(c2.Changes) != 1 || c2.Changes[0].Before != "0.6.9" || c2.Changes[0].After != "0.6.10" {
		t.Fatalf("changes: %+v", c2.Changes)
	}
	r.fail = true
	if _, e = c2.Commit(ctx); e == nil {
		t.Fatal("failed install accepted")
	}
	if s, _ := m.State(); s != first {
		t.Fatal("failure changed activation")
	}
	r.fail = false
	stale, e := m.Plan(ctx, r.version)
	if e != nil {
		t.Fatal(e)
	}
	defer stale.Close()
	if _, e = c2.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	second, _ := m.State()
	if second.Previous != first.Current {
		t.Fatal("previous not retained")
	}
	if _, e = stale.Commit(ctx); e == nil {
		t.Fatal("stale plan accepted")
	}
	calls := r.npmCalls
	if _, e = m.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	if r.npmCalls != calls {
		t.Fatal("rollback called npm")
	}
	if s, _ := m.State(); s.Current != first.Current || s.Previous != second.Current {
		t.Fatal("rollback did not swap")
	}
	preview := Manager{m.Root, "next", r}
	if s, _ := preview.State(); s.Current != "" {
		t.Fatal("channels not isolated")
	}
}
func TestTamperedLockAndInvalidChannel(t *testing.T) {
	ctx := context.Background()
	r := &fakeRunner{dep: "0.6.9"}
	m := Manager{t.TempDir(), "latest", r}
	if _, e := m.Plan(ctx, "0.2.8-beta.1"); e == nil {
		t.Fatal("stable channel accepted beta")
	}
	c, e := m.Plan(ctx, "0.2.8")
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	f := filepath.Join(c.stage, "package-lock.json")
	b, _ := os.ReadFile(f)
	_ = os.WriteFile(f, append(b, ' '), 0600)
	if _, e = c.Commit(ctx); e == nil {
		t.Fatal("changed lock accepted")
	}
	if s, _ := m.State(); s.Current != "" {
		t.Fatal("invalid candidate activated")
	}
}
func TestChannelLock(t *testing.T) {
	dir := t.TempDir()
	unlock, e := lockChannel(dir)
	if e != nil {
		t.Fatal(e)
	}
	if other, e := lockChannel(dir); e == nil {
		other()
		unlock()
		t.Fatal("concurrent lock acquired")
	}
	unlock()
	again, e := lockChannel(dir)
	if e != nil {
		t.Fatal(e)
	}
	again()
}
