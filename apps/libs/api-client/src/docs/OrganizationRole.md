# OrganizationRole


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | Role ID | [default to undefined]
**name** | **string** | Role name | [default to undefined]
**description** | **string** | Role description | [default to undefined]
**permissions** | **Array&lt;string&gt;** | Roles assigned to the user | [default to undefined]
**isGlobal** | **boolean** | Global role flag | [default to undefined]
**createdAt** | **Date** | Creation timestamp | [default to undefined]
**updatedAt** | **Date** | Last update timestamp | [default to undefined]

## Example

```typescript
import { OrganizationRole } from './api';

const instance: OrganizationRole = {
    id,
    name,
    description,
    permissions,
    isGlobal,
    createdAt,
    updatedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
