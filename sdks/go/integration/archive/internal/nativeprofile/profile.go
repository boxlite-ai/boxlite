//go:build boxlite_coverage

// Package nativeprofile flushes LLVM counters from the native library under test.
package nativeprofile

/*
int __llvm_profile_write_file(void);
*/
import "C"

// Flush is required because Go's os.Exit bypasses the native atexit handlers.
func Flush() bool { return C.__llvm_profile_write_file() == 0 }
