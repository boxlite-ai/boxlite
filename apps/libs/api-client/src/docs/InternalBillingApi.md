# InternalBillingApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**billingControllerFetchArchived**](#billingcontrollerfetcharchived) | **GET** /internal/billing/periods/{periodId} | Fetch one archived usage period by id|
|[**billingControllerListOpenForOrganization**](#billingcontrollerlistopenfororganization) | **GET** /internal/billing/organizations/{organizationId}/open-periods | List still-running (hot table) usage periods for an organization|
|[**billingControllerListUnbilled**](#billingcontrollerlistunbilled) | **GET** /internal/billing/unbilled-periods | List unbilled archived usage periods, oldest endAt first|
|[**billingControllerMarkBilled**](#billingcontrollermarkbilled) | **POST** /internal/billing/periods/{periodId}/mark-billed | Compare-and-swap the period from unbilled to billed|

# **billingControllerFetchArchived**
> BillingPeriodDto billingControllerFetchArchived()


### Example

```typescript
import {
    InternalBillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new InternalBillingApi(configuration);

let periodId: string; // (default to undefined)

const { status, data } = await apiInstance.billingControllerFetchArchived(
    periodId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **periodId** | [**string**] |  | defaults to undefined|


### Return type

**BillingPeriodDto**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **billingControllerListOpenForOrganization**
> BillingPeriodListDto billingControllerListOpenForOrganization()


### Example

```typescript
import {
    InternalBillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new InternalBillingApi(configuration);

let organizationId: string; // (default to undefined)

const { status, data } = await apiInstance.billingControllerListOpenForOrganization(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|


### Return type

**BillingPeriodListDto**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **billingControllerListUnbilled**
> BillingPeriodListDto billingControllerListUnbilled()


### Example

```typescript
import {
    InternalBillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new InternalBillingApi(configuration);

let limit: number; // (default to undefined)

const { status, data } = await apiInstance.billingControllerListUnbilled(
    limit
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **limit** | [**number**] |  | defaults to undefined|


### Return type

**BillingPeriodListDto**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **billingControllerMarkBilled**
> MarkBilledResultDto billingControllerMarkBilled()

Returns marked=false if the period was already billed or does not exist -- never an error.

### Example

```typescript
import {
    InternalBillingApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new InternalBillingApi(configuration);

let periodId: string; // (default to undefined)

const { status, data } = await apiInstance.billingControllerMarkBilled(
    periodId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **periodId** | [**string**] |  | defaults to undefined|


### Return type

**MarkBilledResultDto**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

