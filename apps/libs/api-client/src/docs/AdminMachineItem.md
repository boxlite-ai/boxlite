# AdminMachineItem


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**host** | **string** | Runner / host ID | [default to undefined]
**region** | **string** | Region ID | [default to undefined]
**oversellCpu** | **number** | CPU oversell ratio (allocatedCpu / totalCpu); 0 when capacity is 0 | [default to undefined]
**cpuWaterline** | **number** | CPU utilisation waterline (0–100) | [default to undefined]
**memWaterline** | **number** | Memory utilisation waterline (0–100) | [default to undefined]
**boxes** | **number** | Number of currently started boxes on this runner | [default to undefined]

## Example

```typescript
import { AdminMachineItem } from './api';

const instance: AdminMachineItem = {
    host,
    region,
    oversellCpu,
    cpuWaterline,
    memWaterline,
    boxes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
