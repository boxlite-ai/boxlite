# BoxUsage


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**boxId** | **string** |  | [default to undefined]
**firstStart** | **Date** |  | [optional] [default to undefined]
**lastEnd** | **Date** |  | [optional] [default to undefined]
**totalCPUSeconds** | **number** |  | [default to undefined]
**totalDiskGBSeconds** | **number** |  | [default to undefined]
**totalGPUSeconds** | **number** |  | [default to undefined]
**totalPrice** | **number** | Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service. | [default to undefined]
**totalRAMGBSeconds** | **number** |  | [default to undefined]

## Example

```typescript
import { BoxUsage } from './api';

const instance: BoxUsage = {
    boxId,
    firstStart,
    lastEnd,
    totalCPUSeconds,
    totalDiskGBSeconds,
    totalGPUSeconds,
    totalPrice,
    totalRAMGBSeconds,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
