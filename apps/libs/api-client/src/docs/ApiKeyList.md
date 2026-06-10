# ApiKeyList


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **string** | The name of the API key | [default to undefined]
**value** | **string** | The masked API key value | [default to undefined]
**createdAt** | **Date** | When the API key was created | [default to undefined]
**permissions** | **Array&lt;string&gt;** | The list of organization resource permissions assigned to the API key | [default to undefined]
**lastUsedAt** | **Date** | When the API key was last used | [default to undefined]
**expiresAt** | **Date** | When the API key expires | [default to undefined]
**userId** | **string** | The user ID of the user who created the API key | [default to undefined]

## Example

```typescript
import { ApiKeyList } from './api';

const instance: ApiKeyList = {
    name,
    value,
    createdAt,
    permissions,
    lastUsedAt,
    expiresAt,
    userId,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
