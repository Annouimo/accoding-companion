package main

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
	"unsafe"

	"golang.org/x/sys/windows"
)

var driveAPI = windows.NewLazySystemDLL("kernel32.dll")
var logicalDrives = driveAPI.NewProc("GetLogicalDrives")
var defineDevice = driveAPI.NewProc("DefineDosDeviceW")

// MinGW tools pass internal paths through the Windows ANSI code page.
// Give them an ASCII alias without moving the user's files or the compiler.
func nativeCompilerPath(directory string) (string, func(), error) {
	if strings.IndexFunc(directory, func(r rune) bool { return r > unicode.MaxASCII }) == -1 {
		return directory, func() {}, nil
	}
	full, err := filepath.Abs(directory)
	if err != nil {
		return "", nil, err
	}
	target, err := windows.UTF16PtrFromString(full)
	if err != nil {
		return "", nil, err
	}
	const noBroadcast = 8
	const removeExact = 2 | 4 | noBroadcast
	lockName, _ := windows.UTF16PtrFromString(`Local\AccodingCompilerDrive`)
	mutex, err := windows.CreateMutex(nil, false, lockName)
	if err != nil && err != windows.ERROR_ALREADY_EXISTS {
		return "", nil, err
	}
	defer windows.CloseHandle(mutex)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, err := windows.WaitForSingleObject(mutex, 5000)
	if err != nil {
		return "", nil, err
	}
	if result != windows.WAIT_OBJECT_0 && result != windows.WAIT_ABANDONED {
		return "", nil, fmt.Errorf("等待编译器盘符分配超时")
	}
	defer windows.ReleaseMutex(mutex)
	drives, _, callErr := logicalDrives.Call()
	if drives == 0 {
		return "", nil, fmt.Errorf("无法获取可用的 Windows 盘符：%w", callErr)
	}
	for letter := 'Z'; letter >= 'D'; letter-- {
		if drives&(1<<(letter-'A')) != 0 {
			continue
		}
		name := string(letter) + ":"
		device, _ := windows.UTF16PtrFromString(name)
		success, _, _ := defineDevice.Call(noBroadcast, uintptr(unsafe.Pointer(device)), uintptr(unsafe.Pointer(target)))
		if success == 0 {
			continue
		}
		return name + "\\", func() {
			_, _, _ = defineDevice.Call(removeExact, uintptr(unsafe.Pointer(device)), uintptr(unsafe.Pointer(target)))
		}, nil
	}
	return "", nil, fmt.Errorf("无法为编译器的中文路径分配临时盘符")
}
