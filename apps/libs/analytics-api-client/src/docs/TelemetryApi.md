# TelemetryApi

All URIs are relative to *http://localhost:8080*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**organizationOrganizationIdBoxBoxIdTelemetryLogsGet**](#organizationorganizationidboxboxidtelemetrylogsget) | **GET** /organization/{organizationId}/box/{boxId}/telemetry/logs | Get box logs|
|[**organizationOrganizationIdBoxBoxIdTelemetryMetricsGet**](#organizationorganizationidboxboxidtelemetrymetricsget) | **GET** /organization/{organizationId}/box/{boxId}/telemetry/metrics | Get box metrics|
|[**organizationOrganizationIdBoxBoxIdTelemetryTracesGet**](#organizationorganizationidboxboxidtelemetrytracesget) | **GET** /organization/{organizationId}/box/{boxId}/telemetry/traces | Get box traces|
|[**organizationOrganizationIdBoxBoxIdTelemetryTracesTraceIdGet**](#organizationorganizationidboxboxidtelemetrytracestraceidget) | **GET** /organization/{organizationId}/box/{boxId}/telemetry/traces/{traceId} | Get trace spans|

# **organizationOrganizationIdBoxBoxIdTelemetryLogsGet**
> Array<ModelsLogEntry> organizationOrganizationIdBoxBoxIdTelemetryLogsGet()

Retrieve OTEL logs for a box within a time range

### Example

```typescript
import {
    TelemetryApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new TelemetryApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let boxId: string; //Box ID (default to undefined)
let from: string; //Start time (RFC3339) (default to undefined)
let to: string; //End time (RFC3339) (default to undefined)
let severity: string; //Severity filter (comma-separated) (optional) (default to undefined)
let search: string; //Search filter (optional) (default to undefined)
let limit: number; //Page size (optional) (default to undefined)
let offset: number; //Page offset (optional) (default to undefined)

const { status, data } = await apiInstance.organizationOrganizationIdBoxBoxIdTelemetryLogsGet(
    organizationId,
    boxId,
    from,
    to,
    severity,
    search,
    limit,
    offset
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **boxId** | [**string**] | Box ID | defaults to undefined|
| **from** | [**string**] | Start time (RFC3339) | defaults to undefined|
| **to** | [**string**] | End time (RFC3339) | defaults to undefined|
| **severity** | [**string**] | Severity filter (comma-separated) | (optional) defaults to undefined|
| **search** | [**string**] | Search filter | (optional) defaults to undefined|
| **limit** | [**number**] | Page size | (optional) defaults to undefined|
| **offset** | [**number**] | Page offset | (optional) defaults to undefined|


### Return type

**Array<ModelsLogEntry>**

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

# **organizationOrganizationIdBoxBoxIdTelemetryMetricsGet**
> Array<ModelsMetricPoint> organizationOrganizationIdBoxBoxIdTelemetryMetricsGet()

Retrieve OTEL metrics for a box within a time range

### Example

```typescript
import {
    TelemetryApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new TelemetryApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let boxId: string; //Box ID (default to undefined)
let from: string; //Start time (RFC3339) (default to undefined)
let to: string; //End time (RFC3339) (default to undefined)
let metricNames: string; //Metric names filter (comma-separated) (optional) (default to undefined)

const { status, data } = await apiInstance.organizationOrganizationIdBoxBoxIdTelemetryMetricsGet(
    organizationId,
    boxId,
    from,
    to,
    metricNames
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **boxId** | [**string**] | Box ID | defaults to undefined|
| **from** | [**string**] | Start time (RFC3339) | defaults to undefined|
| **to** | [**string**] | End time (RFC3339) | defaults to undefined|
| **metricNames** | [**string**] | Metric names filter (comma-separated) | (optional) defaults to undefined|


### Return type

**Array<ModelsMetricPoint>**

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

# **organizationOrganizationIdBoxBoxIdTelemetryTracesGet**
> Array<ModelsTraceSummary> organizationOrganizationIdBoxBoxIdTelemetryTracesGet()

Retrieve OTEL trace summaries for a box within a time range

### Example

```typescript
import {
    TelemetryApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new TelemetryApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let boxId: string; //Box ID (default to undefined)
let from: string; //Start time (RFC3339) (default to undefined)
let to: string; //End time (RFC3339) (default to undefined)
let limit: number; //Page size (optional) (default to undefined)
let offset: number; //Page offset (optional) (default to undefined)

const { status, data } = await apiInstance.organizationOrganizationIdBoxBoxIdTelemetryTracesGet(
    organizationId,
    boxId,
    from,
    to,
    limit,
    offset
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **boxId** | [**string**] | Box ID | defaults to undefined|
| **from** | [**string**] | Start time (RFC3339) | defaults to undefined|
| **to** | [**string**] | End time (RFC3339) | defaults to undefined|
| **limit** | [**number**] | Page size | (optional) defaults to undefined|
| **offset** | [**number**] | Page offset | (optional) defaults to undefined|


### Return type

**Array<ModelsTraceSummary>**

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

# **organizationOrganizationIdBoxBoxIdTelemetryTracesTraceIdGet**
> Array<ModelsSpan> organizationOrganizationIdBoxBoxIdTelemetryTracesTraceIdGet()

Retrieve all spans for a trace

### Example

```typescript
import {
    TelemetryApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new TelemetryApi(configuration);

let organizationId: string; //Organization ID (default to undefined)
let boxId: string; //Box ID (default to undefined)
let traceId: string; //Trace ID (default to undefined)

const { status, data } = await apiInstance.organizationOrganizationIdBoxBoxIdTelemetryTracesTraceIdGet(
    organizationId,
    boxId,
    traceId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | defaults to undefined|
| **boxId** | [**string**] | Box ID | defaults to undefined|
| **traceId** | [**string**] | Trace ID | defaults to undefined|


### Return type

**Array<ModelsSpan>**

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

