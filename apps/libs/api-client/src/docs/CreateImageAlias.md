# CreateImageAlias


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**alias** | **string** | New catalog alias; existing aliases are refused | [default to undefined]
**versionId** | **string** | Version to point the tag at. It must be a ready version of this image | [default to undefined]

## Example

```typescript
import { CreateImageAlias } from './api';

const instance: CreateImageAlias = {
    alias,
    versionId,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
