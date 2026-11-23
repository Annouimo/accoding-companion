package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestMenuKeepsInstallSeparateFromStart(t *testing.T) {
	m := menu{cursor: 0, action: -1}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if next.(menu).action != 0 {
		t.Fatal("first-time Enter must select Install")
	}
	m.cursor = 1
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if next.(menu).action != 1 {
		t.Fatal("installed Enter must select Start")
	}
}

func TestManagedRuntimeFromChinesePath(t *testing.T) {
	if os.Getenv("ACCODING_TEST_NODE_DOWNLOAD") != "1" {
		t.Skip("requires downloading the pinned Node.js distribution")
	}
	root := filepath.Join(t.TempDir(), "中文 测试目录")
	r, err := installNode(root)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(r.node, root) {
		t.Fatalf("expected managed Node at %s, got %s", root, r.node)
	}
	out, err := exec.Command(r.node, r.npm, "--version").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		t.Fatalf("npm failed after Node installation: %v %s", err, out)
	}
	next, err := findNode(root)
	if err != nil || next != r {
		t.Fatalf("could not rediscover Node.js without restarting: %v", err)
	}
}
