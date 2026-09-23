//go:build boxlite_dev

package boxlite

/*
#include "bridge.h"
*/
import "C"

// cImagePullFieldsForTest reports the two fields cImagePullOptions writes, by
// their C names. Go does not support importing C from a _test.go file, and a
// swap between these two would pull every tenant image with the runtime's
// credentials, so the test needs to see the C side.
func cImagePullFieldsForTest(pull ImagePullOptions) (anonymous, revalidate int) {
	converted := cImagePullOptions(pull)
	return int(converted.anonymous), int(converted.revalidate)
}
