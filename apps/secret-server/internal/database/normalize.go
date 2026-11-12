package database

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// NormalizeName validates a secret name and maps each Unicode scalar to an environment key.
func NormalizeName(name string) (string, error) {
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 64 || strings.ContainsRune(name, 0) {
		return "", errors.New("secret name must contain 1 to 64 valid non-NUL Unicode characters")
	}
	var result strings.Builder
	for _, c := range name {
		switch {
		case c >= 'a' && c <= 'z':
			result.WriteByte(byte(c - 'a' + 'A'))
		case c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_':
			result.WriteByte(byte(c))
		default:
			result.WriteByte('_')
		}
	}
	return result.String(), nil
}
