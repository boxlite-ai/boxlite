# ImageTagEvent


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**tagName** | **string** | The tag that moved | [default to undefined]
**fromVersionId** | **string** | Version the tag pointed at before. Null when the tag did not exist yet | [default to undefined]
**fromDigest** | **string** | Digest of the version the tag pointed at before. Null when the tag did not exist yet | [default to undefined]
**toVersionId** | **string** | Version the tag points at from then on | [default to undefined]
**toDigest** | **string** | Digest of the version the tag points at from then on | [default to undefined]
**actorId** | **string** | Who moved the tag. Null when a box pulling the image is what recorded it | [default to undefined]
**createdAt** | **string** | When the tag moved | [default to undefined]

## Example

```typescript
import { ImageTagEvent } from './api';

const instance: ImageTagEvent = {
    tagName,
    fromVersionId,
    fromDigest,
    toVersionId,
    toDigest,
    actorId,
    createdAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
