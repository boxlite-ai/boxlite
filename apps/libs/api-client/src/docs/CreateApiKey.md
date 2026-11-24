# CreateApiKey


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**proxyPermissions** | **Array&lt;string&gt;** | Outbound proxy permissions | [optional] [default to undefined]
**name** | **string** | The name of the API key | [default to undefined]
**permissions** | **Array&lt;string&gt;** | The list of organization resource permissions explicitly assigned to the API key | [default to undefined]
**expiresAt** | **Date** | When the API key expires | [optional] [default to undefined]

## Example

```typescript
import { CreateApiKey } from './api';

const instance: CreateApiKey = {
    proxyPermissions,
    name,
    permissions,
    expiresAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
