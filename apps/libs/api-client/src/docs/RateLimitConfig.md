# RateLimitConfig


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**failedAuth** | [**RateLimitEntry**](RateLimitEntry.md) | Failed authentication rate limit | [optional] [default to undefined]
**authenticated** | [**RateLimitEntry**](RateLimitEntry.md) | Authenticated rate limit | [optional] [default to undefined]
**boxCreate** | [**RateLimitEntry**](RateLimitEntry.md) | Box create rate limit | [optional] [default to undefined]
**boxLifecycle** | [**RateLimitEntry**](RateLimitEntry.md) | Box lifecycle rate limit | [optional] [default to undefined]

## Example

```typescript
import { RateLimitConfig } from './api';

const instance: RateLimitConfig = {
    failedAuth,
    authenticated,
    boxCreate,
    boxLifecycle,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
