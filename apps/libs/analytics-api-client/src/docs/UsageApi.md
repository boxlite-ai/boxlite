# UsageApi

All URIs are relative to *http://localhost:8080*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**organizationOrganizationIdBoxBoxIdUsageGet**](#organizationorganizationidboxboxidusageget) | **GET** /organization/{organizationId}/box/{boxId}/usage | Get box usage periods|
|[**organizationOrganizationIdUsageAggregatedGet**](#organizationorganizationidusageaggregatedget) | **GET** /organization/{organizationId}/usage/aggregated | Get aggregated usage|
|[**organizationOrganizationIdUsageBoxGet**](#organizationorganizationidusageboxget) | **GET** /organization/{organizationId}/usage/box | Get per-box usage|
|[**organizationOrganizationIdUsageChartGet**](#organizationorganizationidusagechartget) | **GET** /organization/{organizationId}/usage/chart | Get usage chart data|

# **organizationOrganizationIdBoxBoxIdUsageGet**
> Array<ModelsUsagePeriod> organizationOrganizationIdBoxBoxIdUsageGet()

Retrieve usage periods for a specific box within a time range

### Example

```typescript
import {
    UsageApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let boxId: string; //Box ID (default to undefined)
let from: string; //Start time (RFC3339) (default to undefined)
let to: string; //End time (RFC3339) (default to undefined)

const { status, data } = await apiInstance.organizationOrganizationIdBoxBoxIdUsageGet(
    organizationId,
    boxId,
    from,
    to
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **boxId** | [**string**] | Box ID | defaults to undefined|
| **from** | [**string**] | Start time (RFC3339) | defaults to undefined|
| **to** | [**string**] | End time (RFC3339) | defaults to undefined|


### Return type

**Array<ModelsUsagePeriod>**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **organizationOrganizationIdUsageAggregatedGet**
> ModelsAggregatedUsage organizationOrganizationIdUsageAggregatedGet()

Retrieve aggregated usage for an organization within a time range

### Example

```typescript
import {
    UsageApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let from: string; //Start time (RFC3339) (default to undefined)
let to: string; //End time (RFC3339) (default to undefined)

const { status, data } = await apiInstance.organizationOrganizationIdUsageAggregatedGet(
    organizationId,
    from,
    to
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **from** | [**string**] | Start time (RFC3339) | defaults to undefined|
| **to** | [**string**] | End time (RFC3339) | defaults to undefined|


### Return type

**ModelsAggregatedUsage**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **organizationOrganizationIdUsageBoxGet**
> Array<ModelsBoxUsage> organizationOrganizationIdUsageBoxGet()

Retrieve per-box usage for an organization within a time range

### Example

```typescript
import {
    UsageApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let from: string; //Start time (RFC3339) (default to undefined)
let to: string; //End time (RFC3339) (default to undefined)

const { status, data } = await apiInstance.organizationOrganizationIdUsageBoxGet(
    organizationId,
    from,
    to
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **from** | [**string**] | Start time (RFC3339) | defaults to undefined|
| **to** | [**string**] | End time (RFC3339) | defaults to undefined|


### Return type

**Array<ModelsBoxUsage>**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **organizationOrganizationIdUsageChartGet**
> Array<ModelsUsageChartPoint> organizationOrganizationIdUsageChartGet()

Retrieve usage chart data points for an organization within a time range

### Example

```typescript
import {
    UsageApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let from: string; //Start time (RFC3339) (default to undefined)
let to: string; //End time (RFC3339) (default to undefined)
let region: string; //Region filter (optional) (default to undefined)

const { status, data } = await apiInstance.organizationOrganizationIdUsageChartGet(
    organizationId,
    from,
    to,
    region
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **from** | [**string**] | Start time (RFC3339) | defaults to undefined|
| **to** | [**string**] | End time (RFC3339) | defaults to undefined|
| **region** | [**string**] | Region filter | (optional) defaults to undefined|


### Return type

**Array<ModelsUsageChartPoint>**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

