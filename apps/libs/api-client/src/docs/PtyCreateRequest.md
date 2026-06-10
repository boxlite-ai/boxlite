# PtyCreateRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | The unique identifier for the PTY session | [default to undefined]
**cwd** | **string** | Starting directory for the PTY session, defaults to the box\&#39;s working directory | [optional] [default to undefined]
**envs** | **object** | Environment variables for the PTY session | [optional] [default to undefined]
**cols** | **number** | Number of terminal columns | [optional] [default to undefined]
**rows** | **number** | Number of terminal rows | [optional] [default to undefined]
**lazyStart** | **boolean** | Whether to start the PTY session lazily (only start when first client connects) | [optional] [default to false]

## Example

```typescript
import { PtyCreateRequest } from './api';

const instance: PtyCreateRequest = {
    id,
    cwd,
    envs,
    cols,
    rows,
    lazyStart,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
