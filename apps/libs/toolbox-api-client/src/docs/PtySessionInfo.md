# PtySessionInfo


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**active** | **boolean** |  | [default to undefined]
**cols** | **number** |  | [default to undefined]
**createdAt** | **string** |  | [default to undefined]
**cwd** | **string** |  | [default to undefined]
**envs** | **{ [key: string]: string; }** |  | [default to undefined]
**id** | **string** |  | [default to undefined]
**lazyStart** | **boolean** | Whether this session uses lazy start | [default to undefined]
**rows** | **number** |  | [default to undefined]

## Example

```typescript
import { PtySessionInfo } from './api';

const instance: PtySessionInfo = {
    active,
    cols,
    createdAt,
    cwd,
    envs,
    id,
    lazyStart,
    rows,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
