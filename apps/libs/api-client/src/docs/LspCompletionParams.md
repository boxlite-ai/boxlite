# LspCompletionParams


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**languageId** | **string** | Language identifier | [default to undefined]
**pathToProject** | **string** | Path to the project | [default to undefined]
**uri** | **string** | Document URI | [default to undefined]
**position** | [**Position**](Position.md) |  | [default to undefined]
**context** | [**CompletionContext**](CompletionContext.md) |  | [optional] [default to undefined]

## Example

```typescript
import { LspCompletionParams } from './api';

const instance: LspCompletionParams = {
    languageId,
    pathToProject,
    uri,
    position,
    context,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
