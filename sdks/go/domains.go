package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"fmt"
	"sync"
	"unsafe"
)

// DomainTargetType names the kind of target a domain routes to. Only
// DomainTargetBox exists today; an app kind joins it without changing Bind.
type DomainTargetType string

// DomainTargetBox routes a domain to a guest port of a box.
const DomainTargetBox DomainTargetType = "box"

// DomainTarget is what a domain routes to. For DomainTargetBox, Box is a box
// id or name when binding, and the box id when read back.
type DomainTarget struct {
	Type DomainTargetType
	Box  string
	Port uint16
}

// Domain is a domain the organization holds and what it routes to.
type Domain struct {
	// Name is what the domain is bound by: the label of a platform name.
	Name     string
	Hostname string
	URL      string
	// Target is nil while the domain is held but unbound.
	Target *DomainTarget
}

// DomainList is every domain the organization holds, with the allowance
// they count against. MinLength is the shortest name a new claim may use.
type DomainList struct {
	Domains   []Domain
	Limit     uint32
	Used      uint32
	Remaining uint32
	MinLength uint32
}

// Domains is a runtime-scoped handle for the organization's domains. A domain
// argument is a platform name ("demo") or a full hostname.
//
// Each call is one blocking REST request, like Network.Tunnel: ctx is checked
// before the request is sent, not while it is in flight.
type Domains struct {
	mu     sync.Mutex
	handle *C.CBoxliteDomainHandle
}

func closedDomainsError() error {
	return &Error{Code: ErrInvalidState, Message: "domain handle is closed"}
}

// Domains returns the organization's domains. A local runtime returns an
// ErrUnsupported error.
func (r *Runtime) Domains() (*Domains, error) {
	var handle *C.CBoxliteDomainHandle
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_domains(r.handle, &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	return &Domains{handle: handle}, nil
}

// List returns every domain the organization holds, unbound ones included.
func (d *Domains) List(ctx context.Context) (*DomainList, error) {
	if err := d.begin(ctx); err != nil {
		return nil, err
	}
	defer d.mu.Unlock()

	var list *C.CDomainList
	var cerr C.CBoxliteError
	if code := C.boxlite_domain_list(d.handle, &list, &cerr); code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_domain_list(list)

	held := &DomainList{
		Limit:     uint32(list.limit),
		Used:      uint32(list.used),
		Remaining: uint32(list.remaining),
		MinLength: uint32(list.min_length),
	}
	if list.items != nil && list.count > 0 {
		for _, item := range unsafe.Slice(list.items, int(list.count)) {
			held.Domains = append(held.Domains, cDomainToGo(&item))
		}
	}
	return held, nil
}

// Bind routes domain to target, claiming it if new. A domain bound elsewhere
// in the organization moves; other domains on the target port stay. The port
// is not made public: the domain answers once Tunnel has declared it.
func (d *Domains) Bind(ctx context.Context, domain string, target DomainTarget) (*Domain, error) {
	if target.Type != DomainTargetBox {
		return nil, fmt.Errorf("unsupported domain target type %q", target.Type)
	}
	if err := d.begin(ctx); err != nil {
		return nil, err
	}
	defer d.mu.Unlock()

	cDomain := toCString(domain)
	defer C.free(unsafe.Pointer(cDomain))
	cBox := toCString(target.Box)
	defer C.free(unsafe.Pointer(cBox))
	cTarget := C.CDomainTarget{
		_type: C.int32_t(C.BoxliteDomainTargetBox),
		box:   cBox,
		port:  C.uint16_t(target.Port),
	}

	var bound *C.CDomain
	var cerr C.CBoxliteError
	if code := C.boxlite_domain_bind(d.handle, cDomain, &cTarget, &bound, &cerr); code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_domain(bound)
	result := cDomainToGo(bound)
	return &result, nil
}

// Unbind stops routing domain, keeping it for the organization. It is safe
// to repeat; a domain the organization does not hold is ErrNotFound.
func (d *Domains) Unbind(ctx context.Context, domain string) error {
	if err := d.begin(ctx); err != nil {
		return err
	}
	defer d.mu.Unlock()

	cDomain := toCString(domain)
	defer C.free(unsafe.Pointer(cDomain))
	var cerr C.CBoxliteError
	if code := C.boxlite_domain_unbind(d.handle, cDomain, &cerr); code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Close releases the domain handle.
func (d *Domains) Close() error {
	if d != nil {
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.handle != nil {
			C.boxlite_free_domain_handle(d.handle)
			d.handle = nil
		}
	}
	return nil
}

// begin locks d for one call, or returns why the call cannot start. On nil
// the caller owns the lock.
func (d *Domains) begin(ctx context.Context) error {
	if d == nil {
		return closedDomainsError()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	d.mu.Lock()
	if d.handle == nil {
		d.mu.Unlock()
		return closedDomainsError()
	}
	return nil
}

// cDomainToGo copies a CDomain; the caller still owns and frees it.
func cDomainToGo(domain *C.CDomain) Domain {
	result := Domain{
		Name:     cString(domain.name),
		Hostname: cString(domain.hostname),
		URL:      cString(domain.url),
	}
	if domain.target.box != nil {
		result.Target = &DomainTarget{
			Type: DomainTargetBox,
			Box:  cString(domain.target.box),
			Port: uint16(domain.target.port),
		}
	}
	return result
}
