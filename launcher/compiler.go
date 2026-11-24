package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	gccVersion = "15.2.0"
	gccArchive = "https://github.com/brechtsanders/winlibs_mingw/releases/download/15.2.0posix-13.0.0-ucrt-r1/winlibs-x86_64-posix-seh-gcc-15.2.0-mingw-w64ucrt-13.0.0-r1.zip"
	gccDigest  = "a90aa2449c5214dda0bcb8b6e1ab7d1d83af389c200ca5838639bab4e14c3f08"
)

type compilerProbe struct {
	env, alternate, command, filename, standard, source string
}

var compilerProbes = [2]compilerProbe{
	{"ACCODING_CC", "CC", "gcc", "example.c", "c99", "#include <stdio.h>\nint main(void) { return puts(\"C\") < 0; }\n"},
	{"ACCODING_CXX", "CXX", "g++", "example.cpp", "c++17", "#include <iostream>\nint main() { std::cout << 42; }\n"},
}

func managedCompilerBin(root string) string {
	return filepath.Join(root, "compiler", gccVersion, "mingw64", "bin")
}

func compilerFlags(dir string) []string {
	return []string{"PATH=" + dir + string(os.PathListSeparator) + os.Getenv("PATH")}
}

// GCC's -B selects subordinate tools and startup files, but a relocated
// MinGW driver can still omit the directories of its runtime libraries.
// Supply library search paths explicitly as well, for both probes and the CLI.
func managedCompilerPrefixes(toolchain string) []string {
	const target = "x86_64-w64-mingw32"
	return []string{
		filepath.Join(toolchain, "bin"),
		filepath.Join(toolchain, "lib", "gcc", target, gccVersion),
		filepath.Join(toolchain, target, "lib"),
		filepath.Join(toolchain, "lib"),
	}
}

func managedCompilerArgs(prefixes []string) []string {
	args := []string{"-fno-use-linker-plugin"}
	for _, prefix := range prefixes {
		args = append(args, "-B"+filepath.ToSlash(prefix)+"/", "-L"+filepath.ToSlash(prefix))
	}
	return args
}

func checkCompiler(directory, executable string, probe compilerProbe, managed bool) error {
	input := filepath.Join(directory, probe.filename)
	if err := os.WriteFile(input, []byte(probe.source), 0600); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	output := filepath.Join(directory, "probe.exe")
	args := []string{"-std=" + probe.standard, "-iquote", "."}
	env := os.Environ()
	if managed {
		toolchain, cleanup, err := nativeCompilerPath(filepath.Dir(filepath.Dir(executable)))
		if err != nil {
			return err
		}
		defer cleanup()
		bin := filepath.Join(toolchain, "bin")
		executable = filepath.Join(bin, filepath.Base(executable))
		temp, err := os.MkdirTemp(toolchain, ".probe-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(temp)
		env = append(env, "TEMP="+temp, "TMP="+temp)
		args = append(args, managedCompilerArgs(managedCompilerPrefixes(toolchain))...)
	}
	cmd := exec.CommandContext(ctx, executable, append(args, probe.filename, "-o", "probe.exe")...)
	cmd.Dir = directory
	cmd.Env = append(env, compilerFlags(filepath.Dir(executable))...)
	if data, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s 编译失败：%w %s", probe.command, err, strings.TrimSpace(string(data)))
	}
	run := exec.CommandContext(ctx, output)
	run.Dir, run.Env = directory, cmd.Env
	if err := run.Run(); err != nil {
		return fmt.Errorf("%s 生成的程序无法运行：%w", probe.command, err)
	}
	return nil
}

func checkWindowsCompilers(root string) error {
	if runtime.GOOS != "windows" {
		return nil
	}
	fmt.Println("正在检查 C / C++ 编译环境…")
	testDirectory, err := os.MkdirTemp(root, ".compiler-check-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(testDirectory)
	if dir := managedCompilerBin(root); isFile(filepath.Join(dir, "gcc.exe")) &&
		isFile(filepath.Join(dir, "g++.exe")) {
		return nil
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	var settings struct{ CompilerC, CompilerCpp string }
	if data, err := os.ReadFile(filepath.Join(config, "accoding-companion", "state.json")); err == nil {
		_ = json.Unmarshal(data, &settings)
	}
	configured := [2]string{settings.CompilerC, settings.CompilerCpp}
	ready := true
	for index, probe := range compilerProbes {
		found := false
		for _, candidate := range []string{
			os.Getenv(probe.env), os.Getenv(probe.alternate), configured[index], probe.command,
		} {
			if candidate == "" {
				continue
			}
			if executable, err := exec.LookPath(candidate); err == nil && checkCompiler(testDirectory, executable, probe, false) == nil {
				found = true
				break
			}
		}
		ready = ready && found
	}
	if ready {
		return nil
	}
	if runtime.GOARCH != "amd64" {
		fmt.Println("此架构请使用已有编译器或在 Companion 的设置中填写编译器路径。")
		return nil
	}
	return installWindowsCompiler(root, testDirectory)
}

func installWindowsCompiler(root, testDirectory string) error {
	destination := filepath.Join(root, "compiler", gccVersion)
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(filepath.Dir(destination), ".download-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	archive := filepath.Join(stage, "gcc.zip")
	fmt.Println("正在下载便携版 GCC（约 251 MiB）…")
	if err := downloadArchive(gccArchive, archive, gccDigest, 300<<20); err != nil {
		return err
	}
	fmt.Println("正在解压并验证 GCC / G++…")
	extracted := filepath.Join(stage, "files")
	if err := extractWindowsCompiler(archive, extracted); err != nil {
		return err
	}
	for _, probe := range compilerProbes {
		executable := filepath.Join(extracted, "mingw64", "bin", probe.command+".exe")
		if err := checkCompiler(testDirectory, executable, probe, true); err != nil {
			return err
		}
	}
	if isFile(filepath.Join(managedCompilerBin(root), "gcc.exe")) &&
		isFile(filepath.Join(managedCompilerBin(root), "g++.exe")) {
		return nil
	}
	return os.Rename(extracted, destination)
}

func extractWindowsCompiler(archive, destination string) error {
	files, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer files.Close()
	var total uint64
	for _, file := range files.File {
		if !file.Mode().IsRegular() {
			continue
		}
		name := filepath.FromSlash(file.Name)
		if !strings.HasPrefix(file.Name, "mingw64/") || strings.Contains(file.Name, "\\") ||
			!filepath.IsLocal(name) || filepath.Clean(name) != name {
			return fmt.Errorf("编译器压缩包路径无效")
		}
		const maxUnpacked = 2 << 30
		if file.UncompressedSize64 > maxUnpacked-total {
			return fmt.Errorf("编译器解压内容过大")
		}
		total += file.UncompressedSize64
		target := filepath.Join(destination, name)
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		if err := copyCompilerFile(file, target); err != nil {
			return err
		}
	}
	return nil
}

func copyCompilerFile(file *zip.File, target string) error {
	reader, err := file.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, reader)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
