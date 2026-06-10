# UpdateJobStatus


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**status** | [**JobStatus**](JobStatus.md) | The new status of the job | [default to undefined]
**errorMessage** | **string** | Error message if the job failed | [optional] [default to undefined]
**resultMetadata** | **string** | Result metadata for the job | [optional] [default to undefined]

## Example

```typescript
import { UpdateJobStatus } from './api';

const instance: UpdateJobStatus = {
    status,
    errorMessage,
    resultMetadata,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
