# GitStatus


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**currentBranch** | **string** |  | [default to undefined]
**fileStatus** | [**Array&lt;FileStatus&gt;**](FileStatus.md) |  | [default to undefined]
**ahead** | **number** |  | [optional] [default to undefined]
**behind** | **number** |  | [optional] [default to undefined]
**branchPublished** | **boolean** |  | [optional] [default to undefined]

## Example

```typescript
import { GitStatus } from './api';

const instance: GitStatus = {
    currentBranch,
    fileStatus,
    ahead,
    behind,
    branchPublished,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
