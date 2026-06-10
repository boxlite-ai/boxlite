# BuildInfo


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**dockerfileContent** | **string** | The Dockerfile content used for the build | [optional] [default to undefined]
**contextHashes** | **Array&lt;string&gt;** | The context hashes used for the build | [optional] [default to undefined]
**createdAt** | **Date** | The creation timestamp | [default to undefined]
**updatedAt** | **Date** | The last update timestamp | [default to undefined]
**snapshotRef** | **string** | The snapshot reference | [default to undefined]

## Example

```typescript
import { BuildInfo } from './api';

const instance: BuildInfo = {
    dockerfileContent,
    contextHashes,
    createdAt,
    updatedAt,
    snapshotRef,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
