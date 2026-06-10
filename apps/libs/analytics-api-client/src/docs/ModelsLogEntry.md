# ModelsLogEntry


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**body** | **string** |  | [optional] [default to undefined]
**logAttributes** | **{ [key: string]: string; }** |  | [optional] [default to undefined]
**resourceAttributes** | **{ [key: string]: string; }** |  | [optional] [default to undefined]
**serviceName** | **string** |  | [optional] [default to undefined]
**severityNumber** | **number** |  | [optional] [default to undefined]
**severityText** | **string** |  | [optional] [default to undefined]
**spanId** | **string** |  | [optional] [default to undefined]
**timestamp** | **string** |  | [optional] [default to undefined]
**traceId** | **string** |  | [optional] [default to undefined]

## Example

```typescript
import { ModelsLogEntry } from './api';

const instance: ModelsLogEntry = {
    body,
    logAttributes,
    resourceAttributes,
    serviceName,
    severityNumber,
    severityText,
    spanId,
    timestamp,
    traceId,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
