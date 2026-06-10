# GitCommitRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**path** | **string** |  | [default to undefined]
**message** | **string** |  | [default to undefined]
**author** | **string** |  | [default to undefined]
**email** | **string** |  | [default to undefined]
**allow_empty** | **boolean** | Allow creating an empty commit when no changes are staged | [optional] [default to false]

## Example

```typescript
import { GitCommitRequest } from './api';

const instance: GitCommitRequest = {
    path,
    message,
    author,
    email,
    allow_empty,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
