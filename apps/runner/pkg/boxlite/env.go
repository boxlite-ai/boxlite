package boxlite

import "fmt"

const ReservedExecutorEnv = "BOXLITE_EXECUTOR"

func ValidateReservedEnv(env map[string]string) error {
	if _, ok := env[ReservedExecutorEnv]; ok {
		return fmt.Errorf("%s is reserved and cannot be set by user requests", ReservedExecutorEnv)
	}
	return nil
}
