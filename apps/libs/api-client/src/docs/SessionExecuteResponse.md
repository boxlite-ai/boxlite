# SessionExecuteResponse


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**cmdId** | **string** | The ID of the executed command | [optional] [default to undefined]
**output** | **string** | The output of the executed command marked with stdout and stderr prefixes | [optional] [default to undefined]
**exitCode** | **number** | The exit code of the executed command | [optional] [default to undefined]

## Example

```typescript
import { SessionExecuteResponse } from './api';

const instance: SessionExecuteResponse = {
    cmdId,
    output,
    exitCode,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
