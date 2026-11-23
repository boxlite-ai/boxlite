package encryption

import (
	"encoding/binary"
	"encoding/hex"
	"math"
	"slices"
	"strings"
)

// SecretContext identifies an authorized immutable version and its effective
// policy. Hosts and Headers must not be mutated while an operation uses them.
// The service resolves omitted headers and validates templates and destinations.
type SecretContext struct {
	OrganizationID string
	SecretID       string
	Version        uint32
	Hosts          []string
	Headers        map[string]string
}

func (s SecretContext) aad() ([]byte, []byte, error) {
	org, err := uuidBytes(s.OrganizationID)
	if err != nil {
		return nil, nil, err
	}
	secret, err := uuidBytes(s.SecretID)
	if err != nil {
		return nil, nil, err
	}
	if s.Version == 0 || s.Version > math.MaxInt32 || len(s.Hosts) == 0 || len(s.Headers) == 0 {
		return nil, nil, ErrInvalidInput
	}
	identity := append(org, secret...)
	identity = binary.BigEndian.AppendUint32(identity, s.Version)
	valueAAD := append([]byte("boxlite.secret.value.v1\x00"), identity...)
	dekAAD := append([]byte("boxlite.secret.dek.v1\x00"), identity...)
	hosts := make([]string, len(s.Hosts))
	for i, host := range s.Hosts {
		if host == "" {
			return nil, nil, ErrInvalidInput
		}
		hosts[i] = asciiLower(host)
	}
	slices.Sort(hosts)
	hosts = slices.Compact(hosts)
	if uint64(len(hosts)) > math.MaxUint32 || uint64(len(s.Headers)) > math.MaxUint32 {
		return nil, nil, ErrInvalidInput
	}
	valueAAD = binary.BigEndian.AppendUint32(valueAAD, uint32(len(hosts)))
	for _, host := range hosts {
		valueAAD, err = appendString(valueAAD, host)
		if err != nil {
			return nil, nil, err
		}
	}
	headers := make(map[string]string, len(s.Headers))
	names := make([]string, 0, len(s.Headers))
	for name, template := range s.Headers {
		if !validHeaderName(name) {
			return nil, nil, ErrInvalidInput
		}
		name = asciiLower(name)
		if _, exists := headers[name]; exists {
			return nil, nil, ErrInvalidInput
		}
		headers[name] = template
		names = append(names, name)
	}
	slices.Sort(names)
	valueAAD = binary.BigEndian.AppendUint32(valueAAD, uint32(len(names)))
	for _, name := range names {
		valueAAD, err = appendString(valueAAD, name)
		if err != nil {
			return nil, nil, err
		}
		valueAAD, err = appendString(valueAAD, headers[name])
		if err != nil {
			return nil, nil, err
		}
	}
	return valueAAD, dekAAD, nil
}

func appendString(dst []byte, value string) ([]byte, error) {
	if uint64(len(value)) > math.MaxUint32 {
		return nil, ErrInvalidInput
	}
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(value)))
	return append(dst, value...), nil
}

// UUID text accepts either letter case, but requires the standard dashed form.
func uuidBytes(value string) ([]byte, error) {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return nil, ErrInvalidInput
	}
	decoded, err := hex.DecodeString(value[:8] + value[9:13] + value[14:18] + value[19:23] + value[24:])
	if err != nil {
		return nil, ErrInvalidInput
	}
	return decoded, nil
}

func asciiLower(value string) string {
	buf := []byte(value)
	for i, b := range buf {
		if b >= 'A' && b <= 'Z' {
			buf[i] = b + ('a' - 'A')
		}
	}
	return string(buf)
}

// RFC 9110 tchar; denylisted names and template syntax belong to the service.
func validHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for i := range len(name) {
		b := name[i]
		if b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", rune(b)) {
			continue
		}
		return false
	}
	return true
}
