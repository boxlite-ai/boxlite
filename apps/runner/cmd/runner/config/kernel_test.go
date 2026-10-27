package config

import (
	"reflect"
	"testing"
)

func TestKernelPathFromOperatorEnvironment(t *testing.T) {
	previous := config
	config = nil
	t.Cleanup(func() { config = previous })
	t.Setenv("BOXLITE_API_URL", "https://api.example.test")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-runner")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	t.Setenv("BOXLITE_KERNEL_PATH", "/opt/boxlite/kernels/test/kernel.bin")
	got, err := GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	field := reflect.ValueOf(got).Elem().FieldByName("KernelPath")
	if !field.IsValid() || field.String() != "/opt/boxlite/kernels/test/kernel.bin" {
		t.Fatal("runner discarded BOXLITE_KERNEL_PATH")
	}
}
