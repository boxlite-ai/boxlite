# UsageApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getBoxUsage**](#getboxusage) | **GET** /usage/box/{boxId} | Get aggregated usage totals for a box over a time range|
|[**reportBoxActualUsage**](#reportboxactualusage) | **POST** /usage/box/{boxId}/actual | Report a box actual cgroup usage (runner -&gt; control-plane)|

# **getBoxUsage**
> getBoxUsage()


### Example

```typescript
import {
    UsageApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let boxId: string; //ID of the box (default to undefined)
let from: string; //ISO start (default: 30d ago) (optional) (default to undefined)
let to: string; //ISO end (default: now) (optional) (default to undefined)

const { status, data } = await apiInstance.getBoxUsage(
    boxId,
    from,
    to
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | defaults to undefined|
| **from** | [**string**] | ISO start (default: 30d ago) | (optional) defaults to undefined|
| **to** | [**string**] | ISO end (default: now) | (optional) defaults to undefined|


### Return type

void (empty response body)

### Authorization

[oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Aggregated box usage totals |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **reportBoxActualUsage**
> reportBoxActualUsage(reportBoxActualUsageDto)


### Example

```typescript
import {
    UsageApi,
    Configuration,
    ReportBoxActualUsageDto
} from './api';

const configuration = new Configuration();
const apiInstance = new UsageApi(configuration);

let boxId: string; //ID of the box (default to undefined)
let reportBoxActualUsageDto: ReportBoxActualUsageDto; //

const { status, data } = await apiInstance.reportBoxActualUsage(
    boxId,
    reportBoxActualUsageDto
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **reportBoxActualUsageDto** | **ReportBoxActualUsageDto**|  | |
| **boxId** | [**string**] | ID of the box | defaults to undefined|


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**204** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)
