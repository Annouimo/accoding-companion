package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

type menu struct {
	cursor int
	action int
	status string
	note   string
}

var items = []string{"安装", "启动", "更新", "卸载", "使用说明"}

func (m menu) Init() tea.Cmd { return nil }

func (m menu) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if key, ok := msg.(tea.KeyMsg); ok {
		switch key.String() {
		case "up":
			m.cursor = (m.cursor + len(items) - 1) % len(items)
		case "down":
			m.cursor = (m.cursor + 1) % len(items)
		case "enter":
			m.action = m.cursor
			return m, tea.Quit
		case "q", "esc", "ctrl+c":
			m.action = -1
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m menu) View() string {
	var view strings.Builder
	fmt.Fprintln(&view, "Accoding 启动器")
	fmt.Fprintln(&view, m.status)
	fmt.Fprintln(&view)
	for i, item := range items {
		marker := "  "
		if i == m.cursor {
			marker = "› "
		}
		fmt.Fprintln(&view, marker+item)
	}
	if m.note != "" {
		fmt.Fprintln(&view, "\n"+m.note)
	}
	fmt.Fprintln(&view, "\n↑ ↓ 选择 · Enter 确认 · Esc 退出")
	return view.String()
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "启动器出错："+err.Error())
		fmt.Print("按 Enter 关闭。")
		_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		os.Exit(1)
	}
}

func run() error {
	config, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	root := filepath.Join(config, "accoding-launcher")
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	guide := os.Getenv("ACCODING_LAUNCHER_GUIDE")
	if guide == "" {
		guide = filepath.Join(filepath.Dir(executable), "使用说明.html")
	}

	current := readInstallation(root)
	cursor, note := 0, ""
	if current != "" {
		cursor = 1
	}
	for {
		status := "尚未安装"
		if current != "" {
			status = "Companion " + versionOf(current, cliPackage) + " · 资源包 " + versionOf(current, presetPackage)
		}
		result, err := tea.NewProgram(menu{cursor: cursor, action: -1, status: status, note: note}, tea.WithAltScreen()).Run()
		if err != nil {
			return err
		}
		action := result.(menu).action
		if action < 0 {
			return nil
		}
		cursor, note = action, ""
		switch items[action] {
		case "安装", "更新":
			if action == 0 && current != "" {
				cursor, note = 1, "已安装，按 Enter 启动。"
				continue
			}
			if action == 2 && current == "" {
				cursor, note = 0, "请先安装。"
				continue
			}
			oldPreset := versionOf(current, presetPackage)
			newPath, err := install(root, current)
			if err != nil {
				pause("安装或更新失败：" + err.Error())
				continue
			}
			current = newPath
			preset := versionOf(current, presetPackage)
			if action == 2 && oldPreset != preset {
				promptWorkspaceUpdate(root, current, preset)
			}
			cursor, note = 1, "安装已就绪，按 Enter 启动。"
		case "启动":
			if current == "" {
				cursor, note = 0, "请先安装。"
				continue
			}
			if err := start(root, current, guide); err != nil {
				pause("启动失败：" + err.Error())
			}
		case "卸载":
			if current == "" {
				note = "没有由此启动器管理的安装。"
				continue
			}
			if confirm("卸载 Companion 和启动器下载的资源？课程文件及资源快照会保留。") {
				if err := os.Remove(filepath.Join(root, "current")); err != nil {
					pause("卸载失败：" + err.Error())
					continue
				}
				current = ""
				for _, dir := range []string{"packages", "runtime"} {
					if err := os.RemoveAll(filepath.Join(root, dir)); err != nil {
						pause("部分安装文件未能移除：" + err.Error())
					}
				}
				cursor, note = 0, "已卸载。"
			}
		case "使用说明":
			if err := showGuide(guide); err != nil {
				note = "无法打开使用说明：" + err.Error()
			}
		}
	}
}

func confirm(message string) bool {
	fmt.Print(message + " [y/N] ")
	answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	answer = strings.ToLower(strings.TrimSpace(answer))
	return answer == "y" || answer == "yes"
}

func pause(message string) {
	fmt.Println(message)
	fmt.Print("按 Enter 返回。")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}

func showGuide(file string) error {
	if _, err := os.Stat(file); err != nil {
		return err
	}
	return openGuide(file)
}

func companion(root, installed string, args ...string) (*exec.Cmd, error) {
	runtime, err := findNode(root)
	if err != nil {
		return nil, err
	}
	entry := filepath.Join(packagePath(installed, cliPackage), "dist", "accoding.mjs")
	cmd := exec.Command(runtime.node, append([]string{entry}, args...)...)
	cmd.Env = append(os.Environ(), "ACCODING_PRESET_PACKAGE="+packagePath(installed, presetPackage))
	return cmd, nil
}

func start(root, installed, guide string) error {
	cmd, err := companion(root, installed)
	if err != nil {
		return err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	marker := filepath.Join(root, "guide-opened")
	if _, err := os.Stat(marker); os.IsNotExist(err) {
		if showGuide(guide) == nil {
			_ = os.WriteFile(marker, nil, 0600)
		}
	}
	return cmd.Wait()
}

func promptWorkspaceUpdate(root, installed, version string) {
	cmd, err := companion(root, installed, "resources", "update", version, "--preview")
	if err != nil {
		pause(err.Error())
		return
	}
	output, err := cmd.Output()
	if err != nil {
		message := "无法预览课程资源。可以稍后在 Companion 的「更新课程资源」中处理。"
		if failure, ok := err.(*exec.ExitError); ok && len(failure.Stderr) > 0 {
			message += "\n" + strings.TrimSpace(string(failure.Stderr))
		}
		pause(message)
		return
	}
	var plan struct {
		Root               string
		Eligible, Retained int
	}
	if err := json.Unmarshal(output, &plan); err != nil || !filepath.IsAbs(plan.Root) {
		pause("Companion 未返回可用的课程更新预览。")
		return
	}
	fmt.Printf("\n课程 %s\n新题使用 %s · 可更新 %d 道旧题 · 保留 %d 道\n", plan.Root, version, plan.Eligible, plan.Retained)
	if !confirm("更新此课程的资源？") {
		return
	}
	cmd, err = companion(root, installed, "resources", "update", version, "--root", plan.Root)
	if err == nil {
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		err = cmd.Run()
	}
	if err != nil {
		pause("课程资源更新未全部完成。请查看上面的报告。")
	} else {
		pause("课程资源更新完成。")
	}
}

func nodeArch() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH
}
