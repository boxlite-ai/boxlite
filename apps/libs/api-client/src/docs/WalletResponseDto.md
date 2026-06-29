# WalletResponseDto


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**balanceCents** | **number** |  | [default to undefined]
**ongoingBalanceCents** | **number** |  | [default to undefined]
**name** | **string** |  | [default to undefined]
**creditCardConnected** | **boolean** |  | [default to undefined]
**freeBalanceCents** | **number** |  | [optional] [default to undefined]
**paidBalanceCents** | **number** |  | [optional] [default to undefined]
**billingStatus** | **string** |  | [optional] [default to undefined]
**hasFailedOrPendingInvoice** | **boolean** |  | [optional] [default to undefined]

## Example

```typescript
import { WalletResponseDto } from './api';

const instance: WalletResponseDto = {
    balanceCents,
    ongoingBalanceCents,
    name,
    creditCardConnected,
    freeBalanceCents,
    paidBalanceCents,
    billingStatus,
    hasFailedOrPendingInvoice,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
