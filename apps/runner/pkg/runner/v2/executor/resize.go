package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/backend"
)

func (e *Executor) executeResize(ctx context.Context, job *apiclient.Job) {
	ctx = e.extractTraceContext(ctx, job)
	if job.GetClaimToken() == "" {
		e.log.ErrorContext(ctx, "Resize job has no claim token", "job_id", job.GetId())
		return
	}
	// Validate ownership before touching the VM, including claims delivered late.
	if err := e.reportResize(ctx, job, apiclient.JOBSTATUS_IN_PROGRESS, nil, nil); err != nil {
		e.log.ErrorContext(ctx, "Cannot confirm resize lease", "job_id", job.GetId(), "error", err)
		return
	}
	work, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	interval := 30 * time.Second
	if e.heartbeatInterval > 0 {
		interval = e.heartbeatInterval
	}
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-work.Done():
				return
			case <-ticker.C:
				if err := e.reportResize(work, job, apiclient.JOBSTATUS_IN_PROGRESS, nil, nil); err != nil {
					e.log.ErrorContext(work, "Lost resize lease", "job_id", job.GetId(), "error", err)
					cancel()
					return
				}
			}
		}
	}()
	result, err := e.applyResize(work, job)
	lost := work.Err() != nil
	cancel()
	<-done
	if lost || ctx.Err() != nil {
		return
	}
	status := apiclient.JOBSTATUS_COMPLETED
	if err != nil {
		status = apiclient.JOBSTATUS_FAILED // API requeues this attempt; it does not terminate resize.
		e.log.ErrorContext(ctx, "Resize attempt failed; target retained", "job_id", job.GetId(), "box_id", job.GetResourceId(), "error", err)
	}
	if reportErr := e.reportResize(ctx, job, status, result, err); reportErr != nil {
		e.log.ErrorContext(ctx, "Resize result not acknowledged; lease recovery will retry", "job_id", job.GetId(), "error", reportErr)
	}
}

func (e *Executor) applyResize(ctx context.Context, job *apiclient.Job) (*dto.BoxResources, error) {
	var target dto.ResizeBoxPayload
	if err := e.parsePayload(job.Payload, &target); err != nil {
		return nil, err
	}
	if target.Version != 1 || target.CPUs == 0 || target.MemoryMiB == 0 {
		return nil, fmt.Errorf("invalid resize job payload")
	}
	resizer, ok := e.backend.(backend.ResourceResizer)
	if !ok {
		return nil, fmt.Errorf("backend does not support resource resize")
	}
	if _, err := resizer.ResizeResources(ctx, job.GetResourceId(), 0, 0); err != nil {
		return nil, err
	}
	// Mapped RAM can equal the target before guest hotplug finishes. Always submit
	// the explicit target: the runtime then waits for pending hotplug as well.
	result, err := resizer.ResizeResources(ctx, job.GetResourceId(), target.CPUs, target.MemoryMiB)
	if err != nil {
		return nil, err
	}
	if result == nil || result.CPUs != target.CPUs || result.MemoryMiB != target.MemoryMiB {
		return nil, fmt.Errorf("resize returned an incomplete allocation")
	}
	return result, nil
}

func (e *Executor) reportResize(ctx context.Context, job *apiclient.Job, status apiclient.JobStatus,
	result *dto.BoxResources, failure error) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	body := apiclient.NewUpdateJobStatus(status)
	body.SetClaimToken(job.GetClaimToken())
	if failure != nil {
		body.SetErrorMessage(failure.Error())
	}
	if result != nil {
		encoded, err := json.Marshal(result)
		if err != nil {
			return err
		}
		body.SetResultMetadata(string(encoded))
	}
	_, _, err := e.client.JobsAPI.UpdateJobStatus(ctx, job.GetId()).UpdateJobStatus(*body).Execute()
	return err
}
