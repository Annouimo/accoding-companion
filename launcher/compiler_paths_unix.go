//go:build !windows

package main

func nativeCompilerPath(directory string) (string, func(), error) {
	return directory, func() {}, nil
}
