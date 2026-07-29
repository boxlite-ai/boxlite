# UsageChartPoint


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**cpu** | **number** | Average allocated CPUs in this UTC-day bucket | [default to undefined]
**cpuPrice** | **number** | Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service. | [default to undefined]
**diskGB** | **number** | Average allocated disk GB in this UTC-day bucket | [default to undefined]
**diskPrice** | **number** | Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service. | [default to undefined]
**ramGB** | **number** | Average allocated RAM GB in this UTC-day bucket | [default to undefined]
**ramPrice** | **number** | Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service. | [default to undefined]
**time** | **Date** | Start of the UTC-day bucket, clipped to the requested range | [default to undefined]

## Example

```typescript
import { UsageChartPoint } from './api';

const instance: UsageChartPoint = {
    cpu,
    cpuPrice,
    diskGB,
    diskPrice,
    ramGB,
    ramPrice,
    time,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
