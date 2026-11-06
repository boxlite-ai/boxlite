# BoxMemoryUsageDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**boxId** | **string** | Business Box ID. | [default to undefined]
**image** | **string** | Exact image reference from the same Box snapshot; empty is preserved. | [default to undefined]
**memoryBytes** | **string** | Current bytes as a decimal string, between 0 and 9223372036854775807. | [default to undefined]

## Example

```typescript
import { BoxMemoryUsageDto } from './api';

const instance: BoxMemoryUsageDto = {
    boxId,
    image,
    memoryBytes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
