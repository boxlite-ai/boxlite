package boxlite

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestEBSVolumeClaimIsSingleWriter(t *testing.T) {
	volumeID := fmt.Sprintf("test-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_ = os.Remove(filepath.Join(getVolumeMountRecordDir(), volumeID+".owner"))
	})

	if err := claimEBSVolume(volumeID, "box-a"); err != nil {
		t.Fatalf("first claim failed: %v", err)
	}
	if err := claimEBSVolume(volumeID, "box-a"); err != nil {
		t.Fatalf("idempotent claim failed: %v", err)
	}
	if err := claimEBSVolume(volumeID, "box-b"); err == nil {
		t.Fatal("second writer unexpectedly acquired the volume")
	}
	if err := releaseEBSVolumeClaim(volumeID, "box-b"); err == nil {
		t.Fatal("non-owner unexpectedly released the volume")
	}
	if err := releaseEBSVolumeClaim(volumeID, "box-a"); err != nil {
		t.Fatalf("owner failed to release volume: %v", err)
	}
}

func TestEBSProviderResourceIDValidation(t *testing.T) {
	for _, valid := range []string{"vol-0123456789abcdef0", "vol-deadbeef"} {
		if !ebsVolumeIDPattern.MatchString(valid) {
			t.Fatalf("valid id rejected: %s", valid)
		}
	}
	for _, invalid := range []string{"", "volume-123", "vol-ABC", "vol-123;rm"} {
		if ebsVolumeIDPattern.MatchString(invalid) {
			t.Fatalf("invalid id accepted: %s", invalid)
		}
	}
}
