package proc

import (
	"sync"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
)

// Group is the set of service instances of one release.
type Group struct {
	Deployment int
	Services   []*Service
}

// Find returns the service with the given name, or nil.
func (g *Group) Find(name string) *Service {
	for _, s := range g.Services {
		if s.cfg.Name == name {
			return s
		}
	}
	return nil
}

// Exposed returns the service the gateway routes to, or nil.
func (g *Group) Exposed() *Service {
	for _, s := range g.Services {
		if s.cfg.Exposed {
			return s
		}
	}
	return nil
}

// Statuses renders every service in spec order.
func (g *Group) Statuses() []api.ServiceStatus {
	out := make([]api.ServiceStatus, 0, len(g.Services))
	for _, s := range g.Services {
		out = append(out, s.Status())
	}
	return out
}

// Stop stops every service concurrently and returns once all are down.
func (g *Group) Stop(grace time.Duration) {
	var wg sync.WaitGroup
	for _, s := range g.Services {
		wg.Add(1)
		go func(s *Service) {
			defer wg.Done()
			s.Stop(grace)
		}(s)
	}
	wg.Wait()
}

// Restart restarts every service concurrently.
func (g *Group) Restart(grace time.Duration) {
	var wg sync.WaitGroup
	for _, s := range g.Services {
		wg.Add(1)
		go func(s *Service) {
			defer wg.Done()
			s.Restart(grace)
		}(s)
	}
	wg.Wait()
}
