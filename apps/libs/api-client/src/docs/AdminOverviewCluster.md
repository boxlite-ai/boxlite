# AdminOverviewCluster


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**cpuUtil** | **number** | Average CPU utilisation across all runners (0–1) | [default to undefined]
**oversell** | **number** | Average CPU oversell ratio (allocated / capacity); 0 when no capacity | [default to undefined]

## Example

```typescript
import { AdminOverviewCluster } from './api';

const instance: AdminOverviewCluster = {
    cpuUtil,
    oversell,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
