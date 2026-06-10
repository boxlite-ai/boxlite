# OrganizationSuspension


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**reason** | **string** | Suspension reason | [default to undefined]
**until** | **Date** | Suspension until | [default to undefined]
**suspensionCleanupGracePeriodHours** | **number** | Suspension cleanup grace period hours | [optional] [default to undefined]

## Example

```typescript
import { OrganizationSuspension } from './api';

const instance: OrganizationSuspension = {
    reason,
    until,
    suspensionCleanupGracePeriodHours,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
