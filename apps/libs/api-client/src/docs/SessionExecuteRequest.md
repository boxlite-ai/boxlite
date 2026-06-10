# SessionExecuteRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**command** | **string** | The command to execute | [default to undefined]
**runAsync** | **boolean** | Whether to execute the command asynchronously | [optional] [default to undefined]
**async** | **boolean** | Deprecated: Use runAsync instead. Whether to execute the command asynchronously | [optional] [default to undefined]

## Example

```typescript
import { SessionExecuteRequest } from './api';

const instance: SessionExecuteRequest = {
    command,
    runAsync,
    async,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
