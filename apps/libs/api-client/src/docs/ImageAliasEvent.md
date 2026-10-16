# ImageAliasEvent


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**aliasName** | **string** | The alias that moved | [default to undefined]
**fromVersionId** | **string** | Version the alias pointed at before. Null when the alias did not exist yet | [default to undefined]
**fromDigest** | **string** | Previous digest in historical records. Null for alias creation | [default to undefined]
**toVersionId** | **string** | Version selected by the alias | [default to undefined]
**toDigest** | **string** | Digest selected by the alias | [default to undefined]
**actorId** | **string** | Who created the alias. Null when a registry pull seeded it | [default to undefined]
**createdAt** | **string** | When the alias was recorded | [default to undefined]

## Example

```typescript
import { ImageAliasEvent } from './api';

const instance: ImageAliasEvent = {
    aliasName,
    fromVersionId,
    fromDigest,
    toVersionId,
    toDigest,
    actorId,
    createdAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
