# AdminBoxItem


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Box ID | [default to undefined]
**organizationId** | **string** | Organization ID | [default to undefined]
**state** | [**BoxState**](BoxState.md) |  | [default to undefined]
**runnerId** | **string** | Runner ID the box is assigned to | [optional] [default to undefined]
**cpu** | **number** | Allocated CPU (vCPUs) | [default to undefined]
**memoryGiB** | **number** | Allocated memory in GiB | [optional] [default to undefined]
**createdAt** | **string** | Creation timestamp | [default to undefined]
**owner** | [**AdminBoxOwner**](AdminBoxOwner.md) |  | [default to undefined]

## Example

```typescript
import { AdminBoxItem } from './api';

const instance: AdminBoxItem = {
    id,
    organizationId,
    state,
    runnerId,
    cpu,
    memoryGiB,
    createdAt,
    owner,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
