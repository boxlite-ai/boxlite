# AdminCiConnectionUpdate


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**expected_generation** | **string** | Caller-observed binding generation; a mismatch returns 409 without mutation. | [default to undefined]
**allow_private_repositories** | **boolean** |  | [default to undefined]

## Example

```typescript
import { AdminCiConnectionUpdate } from './api';

const instance: AdminCiConnectionUpdate = {
    expected_generation,
    allow_private_repositories,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
