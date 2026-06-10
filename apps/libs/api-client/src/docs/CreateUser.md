# CreateUser


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**email** | **string** |  | [optional] [default to undefined]
**defaultOrganizationDefaultRegionId** | **string** |  | [optional] [default to undefined]
**personalOrganizationDefaultRegionId** | **string** | Deprecated alias for defaultOrganizationDefaultRegionId. | [optional] [default to undefined]
**role** | **string** |  | [optional] [default to undefined]
**emailVerified** | **boolean** |  | [optional] [default to undefined]

## Example

```typescript
import { CreateUser } from './api';

const instance: CreateUser = {
    id,
    name,
    email,
    defaultOrganizationDefaultRegionId,
    personalOrganizationDefaultRegionId,
    role,
    emailVerified,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
