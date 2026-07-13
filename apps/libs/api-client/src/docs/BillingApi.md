# BillingApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**billingControllerGetBoxUsage**](#billingcontrollergetboxusage) | **GET** /organization/{organizationId}/billing/boxes/{boxId} | |
|[**billingControllerGetOverview**](#billingcontrollergetoverview) | **GET** /organization/{organizationId}/billing/overview | |
|[**billingControllerGetPricing**](#billingcontrollergetpricing) | **GET** /organization/{organizationId}/billing/pricing | |
|[**billingPaymentControllerCreateTopUp**](#billingpaymentcontrollercreatetopup) | **POST** /organization/{organizationId}/billing/top-ups | |
|[**billingPaymentControllerGetPaymentState**](#billingpaymentcontrollergetpaymentstate) | **GET** /organization/{organizationId}/billing/payment | |
|[**billingPaymentControllerListReceipts**](#billingpaymentcontrollerlistreceipts) | **GET** /organization/{organizationId}/billing/receipts | |
|[**billingPaymentControllerSetAutoReload**](#billingpaymentcontrollersetautoreload) | **PUT** /organization/{organizationId}/billing/auto-reload | |
|[**billingPaymentControllerSetupPaymentMethod**](#billingpaymentcontrollersetuppaymentmethod) | **POST** /organization/{organizationId}/billing/payment/setup | |
|[**paymentWebhookControllerHandle**](#paymentwebhookcontrollerhandle) | **POST** /billing/webhooks/payment | |

# **billingControllerGetBoxUsage**
> billingControllerGetBoxUsage()


### Example

```typescript
import {
    BillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

let organizationId: string; // (default to undefined)
let boxId: string; // (default to undefined)

const { status, data } = await apiInstance.billingControllerGetBoxUsage(
    organizationId,
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|
| **boxId** | [**string**] |  | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **billingControllerGetOverview**
> billingControllerGetOverview()


### Example

```typescript
import {
    BillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

let organizationId: string; // (default to undefined)
let from: string; // (default to undefined)
let to: string; // (default to undefined)

const { status, data } = await apiInstance.billingControllerGetOverview(
    organizationId,
    from,
    to
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|
| **from** | [**string**] |  | defaults to undefined|
| **to** | [**string**] |  | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **billingControllerGetPricing**
> billingControllerGetPricing()


### Example

```typescript
import {
    BillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

let organizationId: string; // (default to undefined)

const { status, data } = await apiInstance.billingControllerGetPricing(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **billingPaymentControllerCreateTopUp**
> billingPaymentControllerCreateTopUp()


### Example

```typescript
import {
    BillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

let organizationId: string; // (default to undefined)
let idempotencyKey: string; // (default to undefined)

const { status, data } = await apiInstance.billingPaymentControllerCreateTopUp(
    organizationId,
    idempotencyKey
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|
| **idempotencyKey** | [**string**] |  | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **billingPaymentControllerGetPaymentState**
> billingPaymentControllerGetPaymentState()


### Example

```typescript
import {
    BillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

let organizationId: string; // (default to undefined)

const { status, data } = await apiInstance.billingPaymentControllerGetPaymentState(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **billingPaymentControllerListReceipts**
> billingPaymentControllerListReceipts()


### Example

```typescript
import {
    BillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

let organizationId: string; // (default to undefined)
let page: string; // (default to undefined)
let pageSize: string; // (default to undefined)
let query: string; // (default to undefined)

const { status, data } = await apiInstance.billingPaymentControllerListReceipts(
    organizationId,
    page,
    pageSize,
    query
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|
| **page** | [**string**] |  | defaults to undefined|
| **pageSize** | [**string**] |  | defaults to undefined|
| **query** | [**string**] |  | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **billingPaymentControllerSetAutoReload**
> billingPaymentControllerSetAutoReload()


### Example

```typescript
import {
    BillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

let organizationId: string; // (default to undefined)

const { status, data } = await apiInstance.billingPaymentControllerSetAutoReload(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **billingPaymentControllerSetupPaymentMethod**
> billingPaymentControllerSetupPaymentMethod()


### Example

```typescript
import {
    BillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

let organizationId: string; // (default to undefined)

const { status, data } = await apiInstance.billingPaymentControllerSetupPaymentMethod(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **paymentWebhookControllerHandle**
> paymentWebhookControllerHandle()


### Example

```typescript
import {
    BillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BillingApi(configuration);

let stripeSignature: string; // (default to undefined)

const { status, data } = await apiInstance.paymentWebhookControllerHandle(
    stripeSignature
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **stripeSignature** | [**string**] |  | defaults to undefined|


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

