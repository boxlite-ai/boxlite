// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package docs

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/go-openapi/spec"
)

func TestJobConcurrencySchema(t *testing.T) {
	var document spec.Swagger
	if err := json.Unmarshal([]byte(SwaggerInfo.ReadDoc()), &document); err != nil {
		t.Fatal(err)
	}
	schema := document.Definitions["api.JobConcurrency"]
	if !slices.Contains(schema.Required, "maxConcurrentJobs") {
		t.Error("maxConcurrentJobs must be required in the API schema")
	}
	property := schema.Properties["maxConcurrentJobs"]
	if property.Minimum == nil || *property.Minimum != 1 {
		t.Error("maxConcurrentJobs must have minimum 1 in the API schema")
	}
}
