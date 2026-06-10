# ApiKeyResponse


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **string** | The name of the API key | [default to undefined]
**value** | **string** | The API key value | [default to undefined]
**createdAt** | **Date** | When the API key was created | [default to undefined]
**permissions** | **Array&lt;string&gt;** | The list of organization resource permissions assigned to the API key | [default to undefined]
**expiresAt** | **Date** | When the API key expires | [default to undefined]

## Example

```typescript
import { ApiKeyResponse } from './api';

const instance: ApiKeyResponse = {
    name,
    value,
    createdAt,
    permissions,
    expiresAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
