package tap

import (
	"encoding/binary"
	"math"

	log "github.com/sirupsen/logrus"
)

type protocol interface {
	Stream() bool
}

type streamProtocol interface {
	protocol
	Buf() []byte
	Write(buf []byte, size int)
	Read(buf []byte) int
}

type hyperkitProtocol struct {
}

func (s *hyperkitProtocol) Stream() bool {
	return true
}

func (s *hyperkitProtocol) Buf() []byte {
	return make([]byte, 2)
}

func (s *hyperkitProtocol) Write(buf []byte, size int) {
	if size < 0 || size > math.MaxUint16 {
		log.Warnf("size out of range. Resetting to %d", math.MaxUint16)
		size = math.MaxUint16
	}
	binary.LittleEndian.PutUint16(buf, uint16(size)) //#nosec: G115
}

func (s *hyperkitProtocol) Read(buf []byte) int {
	return int(binary.LittleEndian.Uint16(buf[0:2]))
}

type qemuProtocol struct {
}

func (s *qemuProtocol) Stream() bool {
	return true
}

func (s *qemuProtocol) Buf() []byte {
	return make([]byte, 4)
}

func (s *qemuProtocol) Write(buf []byte, size int) {
	if size > math.MaxUint32 {
		log.Warnf("size exceeds max limit. Resetting to: %d", math.MaxInt32)
		size = math.MaxUint32
	}
	binary.BigEndian.PutUint32(buf, uint32(size)) //#nosec: G115. Safely checked
}

func (s *qemuProtocol) Read(buf []byte) int {
	return int(binary.BigEndian.Uint32(buf[0:4]))
}

type bessProtocol struct {
}

func (s *bessProtocol) Stream() bool {
	return false
}

type vfkitProtocol struct {
}

func (s *vfkitProtocol) Stream() bool {
	return false
}
