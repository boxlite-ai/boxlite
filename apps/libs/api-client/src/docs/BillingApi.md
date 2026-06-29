# BillingApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getWallet**](#getwallet) | **GET** /billing/wallet | Get the organization\&#39;s wallet balance + billing status|
|[**topUpWallet**](#topupwallet) | **POST** /billing/wallet/top-up | Start a manual wallet top-up (returns a checkout URL)|

# **getWallet**
> WalletResponseDto getWallet()


### Example

```typescript
import {
    BillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

const { status, data } = await apiInstance.getWallet();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**WalletResponseDto**

### Authorization

[oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **topUpWallet**
> TopUpCheckoutDto topUpWallet(topUpRequestDto)


### Example

```typescript
import {
    BillingApi,
    Configuration,
    TopUpRequestDto
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

let topUpRequestDto: TopUpRequestDto; //

const { status, data } = await apiInstance.topUpWallet(
    topUpRequestDto
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **topUpRequestDto** | **TopUpRequestDto**|  | |


### Return type

**TopUpCheckoutDto**

### Authorization

[oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)
