package managed

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ProcessRunner reuses the existing managed Node runtime. Never installs a
// compiler or runs package lifecycle scripts.
type ProcessRunner struct{ Node, NPMEntry, Cache string }

func (r ProcessRunner) NPM(ctx context.Context, dir string, args ...string) ([]byte, error) {
	args = append([]string{r.NPMEntry}, args...)
	args = append(args, "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=0", "--fetch-timeout=15000")
	if r.Cache != "" {
		args = append(args, "--cache", r.Cache)
	}
	return r.run(ctx, dir, 3*time.Minute, args...)
}
func (r ProcessRunner) CLI(ctx context.Context, dir string, args ...string) ([]byte, error) {
	entry := filepath.Join(dir, "node_modules", filepath.FromSlash(App), "dist", "accoding.mjs")
	return r.run(ctx, dir, 10*time.Second, append([]string{entry}, args...)...)
}
func (r ProcessRunner) run(ctx context.Context, dir string, timeout time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.Node, args...)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		if failure, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("command failed: %w: %s", err, strings.TrimSpace(string(failure.Stderr)))
		}
		return nil, err
	}
	return output, nil
}
