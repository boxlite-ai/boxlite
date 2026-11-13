package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/backend"
)

// The API grants a fixed 120-second lease. Start the local budget at request
// send time and reserve one second for timing uncertainty; never extend on error.
const resizeLeaseBudget = 119 * time.Second

var errResizeClaimRejected = errors.New("resize claim rejected")

func (e *Executor) executeResize(ctx context.Context, job *apiclient.Job) {
	ctx = e.extractTraceContext(ctx, job)
	if job.GetClaimToken() == "" {
		e.log.ErrorContext(ctx, "Resize job has no claim token", "job_id", job.GetId())
		return
	}
	// Validate ownership before touching the VM, including claims delivered late.
	confirmedAt := time.Now()
	if err := e.reportResize(ctx, job, apiclient.JOBSTATUS_IN_PROGRESS, nil, nil); err != nil {
		e.log.ErrorContext(ctx, "Cannot confirm resize lease", "job_id", job.GetId(), "error", err)
		return
	}
	deadline := confirmedAt.Add(resizeLeaseBudget)
	if ctx.Err() != nil || !time.Now().Before(deadline) {
		return
	}
	work, cancel := context.WithCancel(ctx)
	defer cancel()
	// The watchdog runs independently of HTTP renewals, including stalled ones.
	// Its lock also prevents an already-fired callback from cancelling a renewal.
	var leaseMu sync.Mutex
	stopped := false
	watchdog := time.AfterFunc(time.Until(deadline), func() {
		leaseMu.Lock()
		defer leaseMu.Unlock()
		if !stopped && !time.Now().Before(deadline) {
			cancel()
		}
	})
	heartbeat, stopHeartbeat := context.WithCancel(work)
	done := make(chan struct{})
	interval := 30 * time.Second
	if e.heartbeatInterval > 0 {
		interval = e.heartbeatInterval
	}
	go func() {
		defer close(done)
		timer := time.NewTimer(interval)
		defer timer.Stop()
		backoff := time.Second
		for {
			select {
			case <-heartbeat.Done():
				return
			case <-timer.C:
				leaseMu.Lock()
				renewal, stopRenewal := context.WithDeadline(heartbeat, deadline)
				leaseMu.Unlock()
				sentAt := time.Now()
				err := e.reportResize(renewal, job, apiclient.JOBSTATUS_IN_PROGRESS, nil, nil)
				stopRenewal()
				// A rejection wins even if normal shutdown cancelled the request
				// while its response was in flight.
				if errors.Is(err, errResizeClaimRejected) {
					e.log.ErrorContext(work, "Lost resize lease", "job_id", job.GetId(), "error", err)
					cancel()
					return
				}
				if heartbeat.Err() != nil {
					return
				}
				if err != nil {
					e.log.WarnContext(work, "Resize renewal failed; retrying within confirmed lease", "job_id", job.GetId(), "error", err)
					timer.Reset(backoff/2 + time.Duration(rand.Int64N(int64(backoff/2))))
					backoff = min(2*backoff, 5*time.Second)
					continue
				}
				leaseMu.Lock()
				if work.Err() != nil || !time.Now().Before(deadline) || time.Since(sentAt) >= resizeLeaseBudget {
					cancel() // A delayed success cannot revive an expired lease.
					leaseMu.Unlock()
					return
				}
				deadline = sentAt.Add(resizeLeaseBudget)
				watchdog.Reset(time.Until(deadline))
				leaseMu.Unlock()
				backoff = time.Second
				timer.Reset(interval)
			}
		}
	}()
	result, err := e.applyResize(work, job)
	stopHeartbeat()
	<-done
	leaseMu.Lock()
	stopped = true
	watchdog.Stop()
	lost := work.Err() != nil || !time.Now().Before(deadline)
	leaseMu.Unlock()
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
	if target.Version != 1 || target.CPUs < 0.125 || target.CPUs > 255 || math.Round(target.CPUs*1000)/1000 != target.CPUs || target.MemoryMiB == 0 {
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
	_, response, err := e.client.JobsAPI.UpdateJobStatus(ctx, job.GetId()).UpdateJobStatus(*body).Execute()
	if err != nil && response != nil && response.StatusCode >= 400 && response.StatusCode < 500 &&
		response.StatusCode != http.StatusRequestTimeout && response.StatusCode != http.StatusTooManyRequests {
		return fmt.Errorf("%w (HTTP %d): %w", errResizeClaimRejected, response.StatusCode, err)
	}
	return err
}
