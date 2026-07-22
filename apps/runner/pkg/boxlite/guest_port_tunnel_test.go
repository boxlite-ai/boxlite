package boxlite

import (
	"testing"
	"time"
)

func newGuestPortTransportTestClient() *Client {
	return &Client{portTransports: make(map[guestPortTransportKey]*guestPortTransportEntry)}
}

func TestGuestPortTransportReusesEndpointTransport(t *testing.T) {
	client := newGuestPortTransportTestClient()
	first := client.GuestPortTransport("box-1", 3000, nil)
	second := client.GuestPortTransport("box-1", 3000, nil)
	otherPort := client.GuestPortTransport("box-1", 3001, nil)

	if first != second {
		t.Fatal("same box endpoint did not reuse its transport")
	}
	if first == otherPort {
		t.Fatal("different ports unexpectedly shared a transport")
	}
}

func TestGuestPortTransportEvictsIdleEntries(t *testing.T) {
	client := newGuestPortTransportTestClient()
	old := client.GuestPortTransport("old-box", 3000, nil)
	client.portTransports[guestPortTransportKey{boxId: "old-box", port: 3000}].lastUsed =
		time.Now().Add(-guestPortTransportIdleTTL)

	client.GuestPortTransport("new-box", 3000, nil)
	if _, ok := client.portTransports[guestPortTransportKey{boxId: "old-box", port: 3000}]; ok {
		t.Fatal("idle transport was not evicted")
	}
	if replacement := client.GuestPortTransport("old-box", 3000, nil); replacement == old {
		t.Fatal("evicted transport was reused")
	}
}

func TestGuestPortTransportCacheIsBounded(t *testing.T) {
	client := newGuestPortTransportTestClient()
	for port := uint16(1); port <= guestPortTransportLimit+1; port++ {
		client.GuestPortTransport("box-1", port, nil)
	}

	if got := len(client.portTransports); got != guestPortTransportLimit {
		t.Fatalf("transport cache size = %d, want %d", got, guestPortTransportLimit)
	}
}

func TestCloseGuestPortTransportsRemovesOnlySelectedBox(t *testing.T) {
	client := newGuestPortTransportTestClient()
	client.GuestPortTransport("box-1", 3000, nil)
	client.GuestPortTransport("box-2", 3000, nil)

	client.closeGuestPortTransports("box-1")
	if _, ok := client.portTransports[guestPortTransportKey{boxId: "box-1", port: 3000}]; ok {
		t.Fatal("selected box transport was not removed")
	}
	if _, ok := client.portTransports[guestPortTransportKey{boxId: "box-2", port: 3000}]; !ok {
		t.Fatal("unrelated box transport was removed")
	}
}
