# UsageApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**usageControllerGetAggregatedUsage**](#usagecontrollergetaggregatedusage) | **GET** /organization/{organizationId}/usage/aggregated | Get aggregated usage|
|[**usageControllerGetBoxUsage**](#usagecontrollergetboxusage) | **GET** /organization/{organizationId}/usage/box | Get per-box usage|
|[**usageControllerGetBoxUsagePeriods**](#usagecontrollergetboxusageperiods) | **GET** /organization/{organizationId}/box/{boxId}/usage | Get box usage periods|
|[**usageControllerGetUsageChart**](#usagecontrollergetusagechart) | **GET** /organization/{organizationId}/usage/chart | Get usage chart data|

# **usageControllerGetAggregatedUsage**
> AggregatedUsage usageControllerGetAggregatedUsage()

Retrieve aggregated usage for an organization within a time range

### Example

```typescript
import {
    UsageApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let organizationId: string; // (default to undefined)
let from: Date; //Inclusive range start as an RFC3339 timestamp (default to undefined)
let to: Date; //Exclusive range end as an RFC3339 timestamp (default to undefined)

const { status, data } = await apiInstance.usageControllerGetAggregatedUsage(
    organizationId,
    from,
    to
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|
| **from** | [**Date**] | Inclusive range start as an RFC3339 timestamp | defaults to undefined|
| **to** | [**Date**] | Exclusive range end as an RFC3339 timestamp | defaults to undefined|


### Return type

**AggregatedUsage**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **usageControllerGetBoxUsage**
> Array<BoxUsage> usageControllerGetBoxUsage()

Retrieve per-box usage for an organization within a time range

### Example

```typescript
import {
    UsageApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let organizationId: string; // (default to undefined)
let from: Date; //Inclusive range start as an RFC3339 timestamp (default to undefined)
let to: Date; //Exclusive range end as an RFC3339 timestamp (default to undefined)

const { status, data } = await apiInstance.usageControllerGetBoxUsage(
    organizationId,
    from,
    to
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|
| **from** | [**Date**] | Inclusive range start as an RFC3339 timestamp | defaults to undefined|
| **to** | [**Date**] | Exclusive range end as an RFC3339 timestamp | defaults to undefined|


### Return type

**Array<BoxUsage>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **usageControllerGetBoxUsagePeriods**
> Array<UsagePeriod> usageControllerGetBoxUsagePeriods()

Retrieve usage periods for a specific box within a time range

### Example

```typescript
import {
    UsageApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let organizationId: string; // (default to undefined)
let boxId: string; // (default to undefined)
let from: Date; //Inclusive range start as an RFC3339 timestamp (default to undefined)
let to: Date; //Exclusive range end as an RFC3339 timestamp (default to undefined)

const { status, data } = await apiInstance.usageControllerGetBoxUsagePeriods(
    organizationId,
    boxId,
    from,
    to
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|
| **boxId** | [**string**] |  | defaults to undefined|
| **from** | [**Date**] | Inclusive range start as an RFC3339 timestamp | defaults to undefined|
| **to** | [**Date**] | Exclusive range end as an RFC3339 timestamp | defaults to undefined|


### Return type

**Array<UsagePeriod>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **usageControllerGetUsageChart**
> Array<UsageChartPoint> usageControllerGetUsageChart()

Retrieve UTC-day usage chart points for an organization within a time range

### Example

```typescript
import {
    UsageApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let organizationId: string; // (default to undefined)
let from: Date; //Inclusive range start as an RFC3339 timestamp (default to undefined)
let to: Date; //Exclusive range end as an RFC3339 timestamp (default to undefined)
let region: string; //Only include usage recorded in this region (optional) (default to undefined)

const { status, data } = await apiInstance.usageControllerGetUsageChart(
    organizationId,
    from,
    to,
    region
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | defaults to undefined|
| **from** | [**Date**] | Inclusive range start as an RFC3339 timestamp | defaults to undefined|
| **to** | [**Date**] | Exclusive range end as an RFC3339 timestamp | defaults to undefined|
| **region** | [**string**] | Only include usage recorded in this region | (optional) defaults to undefined|


### Return type

**Array<UsageChartPoint>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

