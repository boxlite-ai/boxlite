# CreateBuildInfo


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**dockerfileContent** | **string** | The Dockerfile content used for the build | [default to undefined]
**contextHashes** | **Array&lt;string&gt;** | The context hashes used for the build | [optional] [default to undefined]

## Example

```typescript
import { CreateBuildInfo } from './api';

const instance: CreateBuildInfo = {
    dockerfileContent,
    contextHashes,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
