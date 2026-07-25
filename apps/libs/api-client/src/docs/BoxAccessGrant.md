# BoxAccessGrant


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Unique identifier for the access grant | [default to undefined]
**boxId** | **string** | ID of the box this grant is scoped to | [default to undefined]
**scopes** | **Array&lt;string&gt;** | Capability scopes granted | [default to undefined]
**status** | **string** | Grant status | [default to undefined]
**expiresAt** | **Date** | When the grant expires | [default to undefined]
**createdBy** | **string** | ID of the authenticated user that created the grant | [default to undefined]
**createdAt** | **Date** | When the grant was created | [default to undefined]

## Example

```typescript
import { BoxAccessGrant } from './api';

const instance: BoxAccessGrant = {
    id,
    boxId,
    scopes,
    status,
    expiresAt,
    createdBy,
    createdAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
