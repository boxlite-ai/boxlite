# Deployment patterns

## Production checklist

Before deploying BoxLite to production:

- [ ] **Resource Limits Configured**
  - Set appropriate `cpus` and `memory_mib`
  - Set `auto_delete=0` on boxes that must survive stop
  - Test resource consumption under load

- [ ] **Error Handling Robust**
  - Catch all exceptions
  - Log errors appropriately
  - Implement retry logic if needed
  - Handle timeout scenarios

- [ ] **Logging/Monitoring Enabled**
  - Configure `RUST_LOG` for production logging
  - Monitor box metrics
  - Track runtime metrics
  - Set up alerting for failures

- [ ] **Performance Tested**
  - Load test with expected concurrency
  - Measure box startup time
  - Test resource limits under stress
  - Verify cleanup happens correctly

- [ ] **Security Review**
  - Verify network isolation configured correctly
  - Check resource limits prevent DoS
  - Review error messages (no sensitive data leaked)
  - Audit code execution paths

## Docker container deployment

Run BoxLite inside Docker (requires privileged mode for KVM):

```dockerfile
FROM ubuntu:22.04

# Install dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install BoxLite
RUN pip3 install boxlite

# Copy application
COPY app.py /app/app.py

WORKDIR /app

CMD ["python3", "app.py"]
```

**Run with KVM access:**

```bash
docker run --privileged --device /dev/kvm:/dev/kvm myapp
```

**Notes:**
- Requires `--privileged` and `--device /dev/kvm`
- Not recommended for multi-tenant environments (security)
- Consider VM-based deployment instead

## Kubernetes deployment

Deploy BoxLite on Kubernetes:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: boxlite-app
spec:
  containers:
  - name: app
    image: myapp:latest
    securityContext:
      privileged: true  # Required for KVM
    volumeMounts:
    - name: dev-kvm
      mountPath: /dev/kvm
    resources:
      limits:
        memory: "4Gi"
        cpu: "2"
  volumes:
  - name: dev-kvm
    hostPath:
      path: /dev/kvm
      type: CharDevice
```

**Notes:**
- Requires privileged containers (security consideration)
- Only works on KVM-enabled nodes
- Use node selectors to target appropriate nodes

## Performance optimization

**Box Reuse:**

```python
# Create pool of boxes
boxes = [boxlite.SimpleBox(image="python:slim") for _ in range(10)]
for box in boxes:
    await box.start()

# Reuse boxes for multiple tasks
for i, task in enumerate(tasks):
    box = boxes[i % len(boxes)]
    await box.exec("python", "-c", task.code)
```

**Image Caching:**

```python
# Pre-pull images before high traffic
images = ["python:slim", "node:alpine", "alpine:latest"]
for image in images:
    await runtime.images.pull(image)
# Images are now cached in ~/.boxlite/images/
```

**Concurrent Execution:**

```python
import asyncio

async def run_tasks_concurrently(tasks):
    """Run multiple tasks in parallel."""
    async def run_task(task):
        async with boxlite.SimpleBox(image="python:slim") as box:
            return await box.exec("python", "-c", task.code)

    return await asyncio.gather(*[run_task(t) for t in tasks])
```
