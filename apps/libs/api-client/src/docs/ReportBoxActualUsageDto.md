# ReportBoxActualUsageDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**actualCpuSeconds** | **number** | CPU-seconds actually consumed (cgroup usage_usec delta) | [default to undefined]
**actualRssAvgBytes** | **string** | Mean resident memory across samples, bytes (bigint as string) | [default to undefined]
**actualRssPeakBytes** | **string** | Peak resident memory across samples, bytes (bigint as string) | [default to undefined]
**sampleCount** | **number** | Number of cgroup samples folded into this report | [default to undefined]

## Example

```typescript
import { ReportBoxActualUsageDto } from './api';

const instance: ReportBoxActualUsageDto = {
    actualCpuSeconds,
    actualRssAvgBytes,
    actualRssPeakBytes,
    sampleCount,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
