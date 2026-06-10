# PtyCreateRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**cols** | **number** |  | [optional] [default to undefined]
**cwd** | **string** |  | [optional] [default to undefined]
**envs** | **{ [key: string]: string; }** |  | [optional] [default to undefined]
**id** | **string** |  | [optional] [default to undefined]
**lazyStart** | **boolean** | Don\&#39;t start PTY until first client connects | [optional] [default to undefined]
**rows** | **number** |  | [optional] [default to undefined]

## Example

```typescript
import { PtyCreateRequest } from './api';

const instance: PtyCreateRequest = {
    cols,
    cwd,
    envs,
    id,
    lazyStart,
    rows,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
