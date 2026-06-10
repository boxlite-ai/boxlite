# GitStatus


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**ahead** | **number** |  | [optional] [default to undefined]
**behind** | **number** |  | [optional] [default to undefined]
**branchPublished** | **boolean** |  | [optional] [default to undefined]
**currentBranch** | **string** |  | [default to undefined]
**fileStatus** | [**Array&lt;FileStatus&gt;**](FileStatus.md) |  | [default to undefined]

## Example

```typescript
import { GitStatus } from './api';

const instance: GitStatus = {
    ahead,
    behind,
    branchPublished,
    currentBranch,
    fileStatus,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
