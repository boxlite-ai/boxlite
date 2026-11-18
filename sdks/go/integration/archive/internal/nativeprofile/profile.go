//go:build boxlite_coverage

// Package nativeprofile flushes LLVM counters from the native library under test.
package nativeprofile

/*
void __llvm_profile_initialize_file(void);
int __llvm_profile_write_file(void);
*/
import "C"

// Flush initializes LLVM output and writes counters before Go's os.Exit.
func Flush() bool {
	// Go binaries can omit LLVM's native startup hook, including on Linux.
	C.__llvm_profile_initialize_file()
	return C.__llvm_profile_write_file() == 0
}
