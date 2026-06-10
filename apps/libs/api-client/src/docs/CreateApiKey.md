# CreateApiKey


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**name** | **string** | The name of the API key | [default to undefined]
**permissions** | **Array&lt;string&gt;** | The list of organization resource permissions explicitly assigned to the API key | [default to undefined]
**expiresAt** | **Date** | When the API key expires | [optional] [default to undefined]

## Example

```typescript
import { CreateApiKey } from './api';

const instance: CreateApiKey = {
    name,
    permissions,
    expiresAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
