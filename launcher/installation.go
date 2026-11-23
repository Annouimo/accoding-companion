package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const cliPackage = "@annouimo/accoding-companion"
const presetPackage = "@annouimo/c-exam-kit-preset"

var stableVersion = regexp.MustCompile("^[0-9]+\\.[0-9]+\\.[0-9]+$")

func packagePath(dir, name string) string {
	return filepath.Join(dir, "node_modules", filepath.FromSlash(name))
}

func versionOf(dir, name string) string {
	if dir == "" {
		return ""
	}
	metadata, err := os.ReadFile(filepath.Join(packagePath(dir, name), "package.json"))
	if err != nil {
		return ""
	}
	var pkg struct{ Name, Version string }
	if json.Unmarshal(metadata, &pkg) != nil || pkg.Name != name || !stableVersion.MatchString(pkg.Version) {
		return ""
	}
	return pkg.Version
}

func validInstallation(dir string) bool {
	for name, file := range map[string]string{cliPackage: "dist/accoding.mjs", presetPackage: "preset/manifest.json"} {
		if versionOf(dir, name) == "" || !isFile(filepath.Join(packagePath(dir, name), filepath.FromSlash(file))) {
			return false
		}
	}
	return true
}

func readInstallation(root string) string {
	value, err := os.ReadFile(filepath.Join(root, "current"))
	name := strings.TrimSpace(string(value))
	if err != nil || !strings.HasPrefix(name, "release-") || filepath.Base(name) != name {
		return ""
	}
	dir := filepath.Join(root, "packages", name)
	if validInstallation(dir) {
		return dir
	}
	return ""
}

func install(root, installed string) (string, error) {
	fmt.Println("正在检查 Node.js…")
	r, err := findNode(root)
	if err != nil {
		fmt.Println("正在安装本应用专用的 Node.js…")
		r, err = installNode(root)
		if err != nil {
			return "", fmt.Errorf("安装 Node.js：%w", err)
		}
	}
	fmt.Println("正在检查 Companion 和资源包版本…")
	cli, err := r.latest(cliPackage)
	if err != nil {
		return "", err
	}
	preset, err := r.latest(presetPackage)
	if err != nil {
		return "", err
	}
	if installed != "" {
		fmt.Printf("Companion %s → %s\n资源包 %s → %s\n",
			versionOf(installed, cliPackage), cli, versionOf(installed, presetPackage), preset)
		if versionOf(installed, cliPackage) == cli && versionOf(installed, presetPackage) == preset {
			pause("已是当前发布版本。")
			return installed, nil
		}
		if !confirm("安装上述更新？") {
			return installed, nil
		}
	}
	parent := filepath.Join(root, "packages")
	if err := os.MkdirAll(parent, 0700); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(parent, "release-")
	if err != nil {
		return "", err
	}
	saved := false
	defer func() {
		if !saved {
			_ = os.RemoveAll(stage)
		}
	}()
	fmt.Printf("正在安装 Companion %s 和资源包 %s…\n", cli, preset)
	cmd := exec.Command(r.node, r.npm, "install", "--prefix", stage, "--no-save",
		"--ignore-scripts", "--no-audit", "--no-fund",
		cliPackage+"@"+cli, presetPackage+"@"+preset)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("安装 npm 包：%w", err)
	}
	if !validInstallation(stage) || versionOf(stage, cliPackage) != cli || versionOf(stage, presetPackage) != preset {
		return "", fmt.Errorf("下载的包缺少文件或版本不匹配")
	}
	check := exec.Command(r.node, filepath.Join(packagePath(stage, cliPackage), "dist", "accoding.mjs"), "--version")
	output, err := check.Output()
	if err != nil || strings.TrimSpace(string(output)) != cli {
		return "", fmt.Errorf("无法启动新下载的 Companion %s", cli)
	}
	pointer, err := os.CreateTemp(root, ".current-")
	if err != nil {
		return "", err
	}
	defer os.Remove(pointer.Name())
	_, err = fmt.Fprintln(pointer, filepath.Base(stage))
	closeErr := pointer.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err = os.Rename(pointer.Name(), filepath.Join(root, "current")); err != nil {
		return "", err
	}
	saved = true
	return stage, nil
}
