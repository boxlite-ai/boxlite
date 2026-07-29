# UsagePeriod


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**cpu** | **number** |  | [default to undefined]
**diskGB** | **number** |  | [default to undefined]
**endAt** | **Date** |  | [default to undefined]
**gpu** | **number** |  | [default to undefined]
**price** | **number** | Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service. | [default to undefined]
**ramGB** | **number** |  | [default to undefined]
**startAt** | **Date** |  | [default to undefined]

## Example

```typescript
import { UsagePeriod } from './api';

const instance: UsagePeriod = {
    cpu,
    diskGB,
    endAt,
    gpu,
    price,
    ramGB,
    startAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
