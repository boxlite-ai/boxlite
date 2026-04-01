package virtualnetwork

import (
	"reflect"

	"gvisor.dev/gvisor/pkg/tcpip"
)

func iterateFields(ret map[string]interface{}, valueOf reflect.Value) {
	for i := 0; i < valueOf.NumField(); i++ {
		field := valueOf.Field(i)
		fieldName := valueOf.Type().Field(i).Name
		if field.Kind() == reflect.Struct {
			m := make(map[string]interface{})
			ret[fieldName] = m
			iterateFields(m, field)
			continue
		}
		if counter, ok := field.Interface().(*tcpip.StatCounter); ok {
			ret[fieldName] = counter.Value()
		}
	}
}

func statsAsJSON(sent, received uint64, stats tcpip.Stats) map[string]interface{} {
	root := make(map[string]interface{})
	iterateFields(root, reflect.ValueOf(stats))
	root["BytesSent"] = sent
	root["BytesReceived"] = received
	return root
}
