package client

import (
	"fmt"
	"time"

	"github.com/boxlite-ai/boxlite/sdks/go/internal/binding"
)

// ===========================================================================
// mockBoxProvider — in-memory implementation of boxProvider for use in tests
// ===========================================================================

type mockBoxProvider struct {
	startErr   error
	stopErr    error
	execResult binding.ExecResult
	execErr    error
	info       binding.BoxInfo
}

func newMockBoxProvider(id, image string) *mockBoxProvider {
	return &mockBoxProvider{
		info: binding.BoxInfo{
			ID:        id,
			Image:     image,
			State:     "configured",
			CreatedAt: time.Now(),
		},
	}
}

func (b *mockBoxProvider) Start() error {
	if b.startErr != nil {
		return b.startErr
	}
	b.info.State = "running"
	return nil
}

func (b *mockBoxProvider) Stop() error {
	if b.stopErr != nil {
		return b.stopErr
	}
	b.info.State = "stopped"
	return nil
}

func (b *mockBoxProvider) Info() (binding.BoxInfo, error) {
	return b.info, nil
}

func (b *mockBoxProvider) Exec(_ string, _ binding.ExecOptions) (binding.ExecResult, error) {
	if b.execErr != nil {
		return binding.ExecResult{}, b.execErr
	}
	return b.execResult, nil
}

func (b *mockBoxProvider) Free() {}

// Compile-time check: mockBoxProvider must implement boxProvider.
var _ boxProvider = (*mockBoxProvider)(nil)

// ===========================================================================
// mockRuntimeProvider — in-memory implementation of runtimeProvider for use in tests
// ===========================================================================

type mockRuntimeProvider struct {
	boxes     map[string]*mockBoxProvider
	nextID    int
	createErr error
	getErr    error
	listErr   error
	removeErr error
	freed     bool
}

func newMockRuntimeProvider() *mockRuntimeProvider {
	return &mockRuntimeProvider{
		boxes:  make(map[string]*mockBoxProvider),
		nextID: 1,
	}
}

func (m *mockRuntimeProvider) SetCreateError(err error) { m.createErr = err }
func (m *mockRuntimeProvider) SetGetError(err error)    { m.getErr = err }
func (m *mockRuntimeProvider) SetListError(err error)   { m.listErr = err }
func (m *mockRuntimeProvider) SetRemoveError(err error) { m.removeErr = err }

// AddBox inserts a pre-configured box into the mock runtime for test setup.
func (m *mockRuntimeProvider) AddBox(id, image string) *mockBoxProvider {
	b := newMockBoxProvider(id, image)
	m.boxes[id] = b
	return b
}

func (m *mockRuntimeProvider) CreateBox(name string, opts binding.BoxOptions) (string, error) {
	if m.createErr != nil {
		return "", m.createErr
	}
	id := fmt.Sprintf("box-%d", m.nextID)
	m.nextID++
	b := newMockBoxProvider(id, opts.Image)
	b.info.Name = name
	m.boxes[id] = b
	return id, nil
}

func (m *mockRuntimeProvider) GetBox(idOrName string) (boxProvider, string, error) {
	if m.getErr != nil {
		return nil, "", m.getErr
	}
	for id, b := range m.boxes {
		if id == idOrName || b.info.Name == idOrName {
			return b, b.info.ID, nil
		}
	}
	return nil, "", nil
}

func (m *mockRuntimeProvider) ListBoxes() ([]binding.BoxInfo, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	result := make([]binding.BoxInfo, 0, len(m.boxes))
	for _, b := range m.boxes {
		result = append(result, b.info)
	}
	return result, nil
}

func (m *mockRuntimeProvider) RemoveBox(idOrName string, force bool) error {
	if m.removeErr != nil {
		return m.removeErr
	}
	for id, b := range m.boxes {
		if id == idOrName || b.info.Name == idOrName {
			delete(m.boxes, id)
			return nil
		}
	}
	return fmt.Errorf("box not found: %s", idOrName)
}

func (m *mockRuntimeProvider) Free() { m.freed = true }

// Compile-time check: mockRuntimeProvider must implement runtimeProvider.
var _ runtimeProvider = (*mockRuntimeProvider)(nil)
