// +build windows

package fs

func Umask(mask int) int {
	// no-op for now
	return 0
}
