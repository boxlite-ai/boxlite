# OrganizationConcurrencyDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**current** | **number** | Boxes occupying a concurrency slot now | [default to undefined]
**limit** | **number** | Effective concurrency entitlement. Null means unlimited. | [default to undefined]
**points** | [**Array&lt;OrganizationConcurrencyPointDto&gt;**](OrganizationConcurrencyPointDto.md) | Concurrency changes during the requested rolling window | [default to undefined]

## Example

```typescript
import { OrganizationConcurrencyDto } from './api';

const instance: OrganizationConcurrencyDto = {
    current,
    limit,
    points,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
