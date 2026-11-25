package guardinventory

import (
	"bytes"
	"testing"
)

func TestAppliedTopologyKeepsRoutesAndTranslation(t *testing.T) {
	assertChange := func(routes bool, original, updated string, equal bool) {
		t.Helper()
		left, err := normalizeTopologyJSON([]byte(original), routes)
		if err != nil {
			t.Fatal(err)
		}
		right, err := normalizeTopologyJSON([]byte(updated), routes)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Equal(left, right) != equal {
			t.Fatalf("unexpected normalization of %s and %s", left, right)
		}
	}
	const route = `[{"dst":"default","gateway":"fe80::1","expires":30,"dev":"ens4"}]`
	assertChange(true, route, `[{"dst":"default","gateway":"fe80::1","expires":29,"dev":"ens4"}]`, true)
	assertChange(true, route, `[{"dst":"default","gateway":"fe80::2","expires":30,"dev":"ens4"}]`, false)
	assertChange(true, route, `[]`, false)
	const nat = `{"nftables":[{"rule":{"expr":[{"counter":{"packets":1,"bytes":16}},{"dnat":{"addr":"2001:db8::2"}}]}}]}`
	assertChange(false, nat, `{"nftables":[{"rule":{"expr":[{"counter":{"packets":2,"bytes":32}},{"dnat":{"addr":"2001:db8::2"}}]}}]}`, true)
	assertChange(false, nat, `{"nftables":[{"rule":{"expr":[{"counter":{"packets":1,"bytes":16}},{"dnat":{"addr":"2001:db8::3"}}]}}]}`, false)
}
