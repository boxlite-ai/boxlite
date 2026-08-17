# ObservabilityApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getTenantLogs**](#gettenantlogs) | **GET** /observability/logs | Search tenant-scoped platform and Box logs|
|[**getTenantMetrics**](#gettenantmetrics) | **GET** /observability/metrics | Get allowlisted metrics for an owned Box|
|[**getTenantTraceSpans**](#gettenanttracespans) | **GET** /observability/traces/{traceId} | Get every tenant-owned span in a trace|
|[**getTenantTraces**](#gettenanttraces) | **GET** /observability/traces | Search tenant-scoped distributed traces|

# **getTenantLogs**
> PaginatedLogs getTenantLogs()


### Example

```typescript
import {
    ObservabilityApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ObservabilityApi(configuration);

let from: Date; // (default to undefined)
let to: Date; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let page: number; // (optional) (default to 1)
let limit: number; // (optional) (default to 50)
let sources: Array<'api' | 'worker' | 'runner' | 'runtime-wrapper' | 'box' | 'collector-delivery'>; // (optional) (default to undefined)
let runnerId: string; //Exact logical Runner ID (optional) (default to undefined)
let boxId: string; //Exact Box ID (optional) (default to undefined)
let jobId: string; //Exact Job ID (optional) (default to undefined)
let search: string; //Case-insensitive literal substring (optional) (default to undefined)
let severities: Array<'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'>; // (optional) (default to undefined)
let traceId: string; //Exact OpenTelemetry trace ID (optional) (default to undefined)

const { status, data } = await apiInstance.getTenantLogs(
    from,
    to,
    xBoxLiteOrganizationID,
    page,
    limit,
    sources,
    runnerId,
    boxId,
    jobId,
    search,
    severities,
    traceId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **from** | [**Date**] |  | defaults to undefined|
| **to** | [**Date**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **page** | [**number**] |  | (optional) defaults to 1|
| **limit** | [**number**] |  | (optional) defaults to 50|
| **sources** | **Array<&#39;api&#39; &#124; &#39;worker&#39; &#124; &#39;runner&#39; &#124; &#39;runtime-wrapper&#39; &#124; &#39;box&#39; &#124; &#39;collector-delivery&#39; &#124; &#39;11184809&#39;>** |  | (optional) defaults to undefined|
| **runnerId** | [**string**] | Exact logical Runner ID | (optional) defaults to undefined|
| **boxId** | [**string**] | Exact Box ID | (optional) defaults to undefined|
| **jobId** | [**string**] | Exact Job ID | (optional) defaults to undefined|
| **search** | [**string**] | Case-insensitive literal substring | (optional) defaults to undefined|
| **severities** | **Array<&#39;DEBUG&#39; &#124; &#39;INFO&#39; &#124; &#39;WARN&#39; &#124; &#39;ERROR&#39; &#124; &#39;FATAL&#39; &#124; &#39;11184809&#39;>** |  | (optional) defaults to undefined|
| **traceId** | [**string**] | Exact OpenTelemetry trace ID | (optional) defaults to undefined|


### Return type

**PaginatedLogs**

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

# **getTenantMetrics**
> MetricsResponse getTenantMetrics()


### Example

```typescript
import {
    ObservabilityApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ObservabilityApi(configuration);

let from: Date; // (default to undefined)
let to: Date; // (default to undefined)
let boxId: string; //Exact Box ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let metricNames: Array<string>; //Allowlisted metric names (optional) (default to undefined)

const { status, data } = await apiInstance.getTenantMetrics(
    from,
    to,
    boxId,
    xBoxLiteOrganizationID,
    metricNames
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **from** | [**Date**] |  | defaults to undefined|
| **to** | [**Date**] |  | defaults to undefined|
| **boxId** | [**string**] | Exact Box ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **metricNames** | **Array&lt;string&gt;** | Allowlisted metric names | (optional) defaults to undefined|


### Return type

**MetricsResponse**

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

# **getTenantTraceSpans**
> Array<TraceSpan> getTenantTraceSpans()


### Example

```typescript
import {
    ObservabilityApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ObservabilityApi(configuration);

let traceId: string; // (default to undefined)
let from: Date; // (default to undefined)
let to: Date; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let boxId: string; //Optional owned Box filter (optional) (default to undefined)

const { status, data } = await apiInstance.getTenantTraceSpans(
    traceId,
    from,
    to,
    xBoxLiteOrganizationID,
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **traceId** | [**string**] |  | defaults to undefined|
| **from** | [**Date**] |  | defaults to undefined|
| **to** | [**Date**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **boxId** | [**string**] | Optional owned Box filter | (optional) defaults to undefined|


### Return type

**Array<TraceSpan>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**413** | Trace contains more than 1000 spans |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getTenantTraces**
> PaginatedTraces getTenantTraces()


### Example

```typescript
import {
    ObservabilityApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ObservabilityApi(configuration);

let from: Date; // (default to undefined)
let to: Date; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let page: number; // (optional) (default to 1)
let limit: number; // (optional) (default to 50)
let sources: Array<'api' | 'worker' | 'runner' | 'runtime-wrapper' | 'box' | 'collector-delivery'>; // (optional) (default to undefined)
let runnerId: string; //Exact logical Runner ID (optional) (default to undefined)
let boxId: string; //Exact Box ID (optional) (default to undefined)
let jobId: string; //Exact Job ID (optional) (default to undefined)

const { status, data } = await apiInstance.getTenantTraces(
    from,
    to,
    xBoxLiteOrganizationID,
    page,
    limit,
    sources,
    runnerId,
    boxId,
    jobId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **from** | [**Date**] |  | defaults to undefined|
| **to** | [**Date**] |  | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **page** | [**number**] |  | (optional) defaults to 1|
| **limit** | [**number**] |  | (optional) defaults to 50|
| **sources** | **Array<&#39;api&#39; &#124; &#39;worker&#39; &#124; &#39;runner&#39; &#124; &#39;runtime-wrapper&#39; &#124; &#39;box&#39; &#124; &#39;collector-delivery&#39; &#124; &#39;11184809&#39;>** |  | (optional) defaults to undefined|
| **runnerId** | [**string**] | Exact logical Runner ID | (optional) defaults to undefined|
| **boxId** | [**string**] | Exact Box ID | (optional) defaults to undefined|
| **jobId** | [**string**] | Exact Job ID | (optional) defaults to undefined|


### Return type

**PaginatedTraces**

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

