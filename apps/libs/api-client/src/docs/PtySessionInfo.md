# PtySessionInfo


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | The unique identifier for the PTY session | [default to undefined]
**cwd** | **string** | Starting directory for the PTY session, defaults to the box\&#39;s working directory | [default to undefined]
**envs** | **object** | Environment variables for the PTY session | [default to undefined]
**cols** | **number** | Number of terminal columns | [default to undefined]
**rows** | **number** | Number of terminal rows | [default to undefined]
**createdAt** | **string** | When the PTY session was created | [default to undefined]
**active** | **boolean** | Whether the PTY session is currently active | [default to undefined]
**lazyStart** | **boolean** | Whether the PTY session uses lazy start (only start when first client connects) | [default to false]

## Example

```typescript
import { PtySessionInfo } from './api';

const instance: PtySessionInfo = {
    id,
    cwd,
    envs,
    cols,
    rows,
    createdAt,
    active,
    lazyStart,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
