# AdminObservabilityClickStackSourceSetup


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**kind** | **string** |  | [default to undefined]
**envVar** | **string** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**dataType** | **string** |  | [default to undefined]
**database** | **string** |  | [default to undefined]
**table** | **string** |  | [optional] [default to undefined]
**timestampColumn** | **string** |  | [default to undefined]
**defaultSelect** | **string** |  | [optional] [default to undefined]
**fields** | **{ [key: string]: any; }** |  | [optional] [default to undefined]
**metricTables** | **{ [key: string]: any; }** |  | [optional] [default to undefined]

## Example

```typescript
import { AdminObservabilityClickStackSourceSetup } from './api';

const instance: AdminObservabilityClickStackSourceSetup = {
    kind,
    envVar,
    name,
    dataType,
    database,
    table,
    timestampColumn,
    defaultSelect,
    fields,
    metricTables,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
