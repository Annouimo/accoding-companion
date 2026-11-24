package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestMenuKeepsInstallSeparateFromStart(t *testing.T) {
	m := menu{options: menuOptions(false, nil), action: -1}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if next.(menu).action != installAction {
		t.Fatal("first-time Enter must select Install")
	}
	m.options = menuOptions(true, nil)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if next.(menu).action != startAction {
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

func TestInstalledMenuOnlyShowsAvailableActions(t *testing.T) {
	options := menuOptions(true, []string{"C Exam Kit: 0.6.6 → 0.6.7"})
	if len(options) != 4 || options[1].label != "更新 C Exam Kit" {
		t.Fatalf("unexpected options: %v", options)
	}
	if len(menuOptions(true, nil)) != 3 || len(menuOptions(false, nil)) != 2 {
		t.Fatal("unexpected menu for an installation without updates")
	}
	if !newerVersion("0.6.10", "0.6.9") || newerVersion("0.6.9", "0.6.10") {
		t.Fatal("versions must be compared numerically")
	}
}

func TestManagedGCCFromChinesePath(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" || os.Getenv("ACCODING_TEST_GCC_DOWNLOAD") != "1" {
		t.Skip("requires Windows x64 and the pinned compiler download")
	}
	root := filepath.Join(t.TempDir(), "中文 路径")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := installWindowsCompiler(root, root); err != nil {
		t.Fatal(err)
	}
	for _, probe := range compilerProbes {
		executable := filepath.Join(managedCompilerBin(root), probe.command+".exe")
		if err := checkCompiler(root, executable, probe, true); err != nil {
			t.Fatal(err)
		}
	}
}

func TestManagedCompilerArgsIncludeRuntimeSearchPaths(t *testing.T) {
	root := filepath.Join("toolchain", "mingw64")
	prefixes := managedCompilerPrefixes(root)
	args := managedCompilerArgs(prefixes)
	for _, prefix := range prefixes {
		directory := filepath.ToSlash(prefix)
		for _, want := range []string{"-B" + directory + "/", "-L" + directory} {
			found := false
			for _, arg := range args {
				found = found || arg == want
			}
			if !found {
				t.Fatalf("missing compiler argument %q in %v", want, args)
			}
		}
	}
}
