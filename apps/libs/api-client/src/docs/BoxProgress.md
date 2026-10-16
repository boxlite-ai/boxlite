# BoxProgress


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**phase** | [**BoxProgressPhase**](BoxProgressPhase.md) | What this box is waiting on while it is being created | [default to undefined]
**retryAfterMs** | **number** | Suggested wait before asking about this box again, in milliseconds. A hint, not a deadline | [default to undefined]

## Example

```typescript
import { BoxProgress } from './api';

const instance: BoxProgress = {
    phase,
    retryAfterMs,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
