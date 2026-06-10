# LspCompletionParams


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**context** | [**CompletionContext**](CompletionContext.md) |  | [optional] [default to undefined]
**languageId** | **string** |  | [default to undefined]
**pathToProject** | **string** |  | [default to undefined]
**position** | [**LspPosition**](LspPosition.md) |  | [default to undefined]
**uri** | **string** |  | [default to undefined]

## Example

```typescript
import { LspCompletionParams } from './api';

const instance: LspCompletionParams = {
    context,
    languageId,
    pathToProject,
    position,
    uri,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
