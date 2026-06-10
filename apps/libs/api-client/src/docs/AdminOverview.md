# AdminOverview


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**users** | **number** | Total number of users | [default to undefined]
**activeBoxes** | **number** | Number of active (started) boxes | [default to undefined]
**boxes** | [**AdminOverviewBoxes**](AdminOverviewBoxes.md) |  | [default to undefined]
**runners** | [**AdminOverviewRunners**](AdminOverviewRunners.md) |  | [default to undefined]
**cluster** | [**AdminOverviewCluster**](AdminOverviewCluster.md) |  | [default to undefined]

## Example

```typescript
import { AdminOverview } from './api';

const instance: AdminOverview = {
    users,
    activeBoxes,
    boxes,
    runners,
    cluster,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
