package boxlite

import (
	"reflect"
	"testing"
)

func TestEFSProviderIDs(t *testing.T) {
	if !efsFileSystemIDPattern.MatchString("fs-0123456789abcdef0") {
		t.Fatal("valid EFS file system id rejected")
	}
	if !efsAccessPointIDPattern.MatchString("fsap-0123456789abcdef0") {
		t.Fatal("valid EFS access point id rejected")
	}
	for _, value := range []string{"", "fsap-1", "vol-123", "fsap-../../tmp"} {
		if efsAccessPointIDPattern.MatchString(value) {
			t.Fatalf("invalid EFS access point id accepted: %q", value)
		}
	}
	for _, value := range []string{"", "fs-1", "vol-123", "fs-../../tmp"} {
		if efsFileSystemIDPattern.MatchString(value) {
			t.Fatalf("invalid EFS file system id accepted: %q", value)
		}
	}
}

func TestEFSMountArgs(t *testing.T) {
	got := efsMountArgs(
		"fs-0123456789abcdef0",
		"fsap-0123456789abcdef0",
		"/var/lib/boxlite/volumes/volume-1",
	)
	want := []string{
		"-t", "efs",
		"-o", "tls,accesspoint=fsap-0123456789abcdef0",
		"fs-0123456789abcdef0:/",
		"/var/lib/boxlite/volumes/volume-1",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected EFS mount args:\n got: %#v\nwant: %#v", got, want)
	}
}
