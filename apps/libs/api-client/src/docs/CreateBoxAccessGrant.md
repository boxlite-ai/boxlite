# CreateBoxAccessGrant


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**scopes** | **Array&lt;string&gt;** | Capability scopes requested for this box-scoped app key. Only \&quot;ssh\&quot; is supported today. | [default to undefined]
**expiresInSeconds** | **number** | Grant lifetime in seconds (default 3600, min 60, max 86400) | [optional] [default to undefined]

## Example

```typescript
import { CreateBoxAccessGrant } from './api';

const instance: CreateBoxAccessGrant = {
    scopes,
    expiresInSeconds,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
