# KeyboardPressRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**key** | **string** | The key to press (e.g., a, b, c, enter, space, etc.) | [default to undefined]
**modifiers** | **Array&lt;string&gt;** | Array of modifier keys to press along with the main key (ctrl, alt, shift, cmd) | [optional] [default to undefined]

## Example

```typescript
import { KeyboardPressRequest } from './api';

const instance: KeyboardPressRequest = {
    key,
    modifiers,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
