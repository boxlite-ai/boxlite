package tap

import (
	"errors"
	"math"
	"net"
	"sync"

	"github.com/apparentlymart/go-cidr/cidr"
)

type IPPool struct {
	base   *net.IPNet
	count  uint64
	leases map[string]string
	lock   sync.Mutex
}

func NewIPPool(base *net.IPNet) *IPPool {
	return &IPPool{
		base:   base,
		count:  cidr.AddressCount(base),
		leases: make(map[string]string),
	}
}

func (p *IPPool) Leases() map[string]string {
	p.lock.Lock()
	defer p.lock.Unlock()
	leases := map[string]string{}
	for key, value := range p.leases {
		leases[key] = value
	}
	return leases
}

func (p *IPPool) Mask() int {
	ones, _ := p.base.Mask.Size()
	return ones
}

func (p *IPPool) GetOrAssign(mac string) (net.IP, error) {
	p.lock.Lock()
	defer p.lock.Unlock()

	for ip, candidate := range p.leases {
		if candidate == mac {
			return net.ParseIP(ip), nil
		}
	}

	if p.count > math.MaxInt {
		return nil, errors.New("IP pool exceeds maximum number of IP addresses")
	}
	for i := 1; i < int(p.count); i++ {
		candidate, err := cidr.Host(p.base, i)
		if err != nil {
			continue
		}
		if _, ok := p.leases[candidate.String()]; !ok {
			p.leases[candidate.String()] = mac
			return candidate, nil
		}
	}
	return nil, errors.New("cannot find available IP")
}

func (p *IPPool) Reserve(ip net.IP, mac string) {
	p.lock.Lock()
	defer p.lock.Unlock()

	p.leases[ip.String()] = mac
}

func (p *IPPool) Release(given string) {
	p.lock.Lock()
	defer p.lock.Unlock()

	var found string
	for ip, mac := range p.leases {
		if mac == given {
			found = ip
			break
		}
	}
	if found != "" {
		delete(p.leases, found)
	}
}
