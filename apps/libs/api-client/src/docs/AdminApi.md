# AdminApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**adminCreateRunner**](#admincreaterunner) | **POST** /admin/runners | Create runner|
|[**adminDeleteRunner**](#admindeleterunner) | **DELETE** /admin/runners/{id} | Delete runner|
|[**adminGetBillingHealth**](#admingetbillinghealth) | **GET** /admin/billing/health | Get Billing recovery and ledger health|
|[**adminGetObservabilityLogs**](#admingetobservabilitylogs) | **GET** /admin/observability/logs | Get admin-scoped logs|
|[**adminGetObservabilityMetrics**](#admingetobservabilitymetrics) | **GET** /admin/observability/metrics | Get admin-scoped metrics|
|[**adminGetObservabilityStatus**](#admingetobservabilitystatus) | **GET** /admin/observability/status | Get admin observability backend and layer status|
|[**adminGetObservabilityTraceSpans**](#admingetobservabilitytracespans) | **GET** /admin/observability/traces/{traceId} | Get admin-scoped trace spans|
|[**adminGetObservabilityTraces**](#admingetobservabilitytraces) | **GET** /admin/observability/traces | Get admin-scoped traces|
|[**adminGetOverview**](#admingetoverview) | **GET** /admin/overview | Admin KPI summary|
|[**adminGetRunnerById**](#admingetrunnerbyid) | **GET** /admin/runners/{id} | Get runner by ID|
|[**adminInvestigateObservability**](#admininvestigateobservability) | **GET** /admin/observability/investigate | Investigate related observability and platform state from trace or resource identifiers|
|[**adminListBoxes**](#adminlistboxes) | **GET** /admin/overview/boxes | List all boxes (cross-org)|
|[**adminListMachines**](#adminlistmachines) | **GET** /admin/overview/machines | Runner-as-machine resource view|
|[**adminListRunners**](#adminlistrunners) | **GET** /admin/runners | List all runners|
|[**adminListRunnersOverview**](#adminlistrunnersoverview) | **GET** /admin/overview/runners | List all runners with full details|
|[**adminListUsers**](#adminlistusers) | **GET** /admin/overview/users | List all users (cross-org)|
|[**adminReconcileBilling**](#adminreconcilebilling) | **POST** /admin/billing/reconcile | Run due Billing recovery work|
|[**adminReconcileSetup**](#adminreconcilesetup) | **POST** /admin/billing/reconcile/setup/{organizationId} | Force provider reconciliation for one payment setup|
|[**adminReconcileTopUp**](#adminreconciletopup) | **POST** /admin/billing/reconcile/top-up/{topUpId} | Force provider reconciliation for one top-up|
|[**adminRecoverBox**](#adminrecoverbox) | **POST** /admin/box/{boxId}/recover | Recover box from error state as an admin|
|[**adminUpdateRunnerScheduling**](#adminupdaterunnerscheduling) | **PATCH** /admin/runners/{id}/scheduling | Update runner scheduling status|

# **adminCreateRunner**
> CreateRunnerResponse adminCreateRunner(adminCreateRunner)


### Example

```typescript
import {
    AdminApi,
    Configuration,
    AdminCreateRunner
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let adminCreateRunner: AdminCreateRunner; //

const { status, data } = await apiInstance.adminCreateRunner(
    adminCreateRunner
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **adminCreateRunner** | **AdminCreateRunner**|  | |


### Return type

**CreateRunnerResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminDeleteRunner**
> adminDeleteRunner()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let id: string; //Runner ID (default to undefined)

const { status, data } = await apiInstance.adminDeleteRunner(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Runner ID | defaults to undefined|


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
|**204** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminGetBillingHealth**
> adminGetBillingHealth()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

const { status, data } = await apiInstance.adminGetBillingHealth();
```

### Parameters
This endpoint does not have any parameters.


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

# **adminGetObservabilityLogs**
> PaginatedLogs adminGetObservabilityLogs()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let from: Date; //Start of time range (ISO 8601) (optional) (default to undefined)
let to: Date; //End of time range (ISO 8601) (optional) (default to undefined)
let page: number; //Page number (1-indexed) (optional) (default to 1)
let limit: number; //Number of items per page (optional) (default to 100)
let layer: 'api' | 'runner' | 'ec2_host' | 'box'; //Telemetry producer layer (optional) (default to undefined)
let serviceName: string; //OpenTelemetry service.name filter (optional) (default to undefined)
let orgId: string; //Organization ID filter (optional) (default to undefined)
let userId: string; //User ID filter (optional) (default to undefined)
let boxId: string; //Box ID filter (optional) (default to undefined)
let runnerId: string; //Runner ID filter (optional) (default to undefined)
let machineId: string; //Machine or host ID filter (optional) (default to undefined)
let traceId: string; //Trace ID filter (optional) (default to undefined)
let requestId: string; //Request ID filter (optional) (default to undefined)
let operationId: string; //Operation ID filter (optional) (default to undefined)
let executionId: string; //Execution ID filter (optional) (default to undefined)
let jobId: string; //Job ID filter (optional) (default to undefined)
let severities: Array<string>; //Filter by severity levels (DEBUG, INFO, WARN, ERROR) (optional) (default to undefined)
let search: string; //Search in log body (optional) (default to undefined)

const { status, data } = await apiInstance.adminGetObservabilityLogs(
    from,
    to,
    page,
    limit,
    layer,
    serviceName,
    orgId,
    userId,
    boxId,
    runnerId,
    machineId,
    traceId,
    requestId,
    operationId,
    executionId,
    jobId,
    severities,
    search
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **from** | [**Date**] | Start of time range (ISO 8601) | (optional) defaults to undefined|
| **to** | [**Date**] | End of time range (ISO 8601) | (optional) defaults to undefined|
| **page** | [**number**] | Page number (1-indexed) | (optional) defaults to 1|
| **limit** | [**number**] | Number of items per page | (optional) defaults to 100|
| **layer** | [**&#39;api&#39; | &#39;runner&#39; | &#39;ec2_host&#39; | &#39;box&#39;**]**Array<&#39;api&#39; &#124; &#39;runner&#39; &#124; &#39;ec2_host&#39; &#124; &#39;box&#39; &#124; &#39;11184809&#39;>** | Telemetry producer layer | (optional) defaults to undefined|
| **serviceName** | [**string**] | OpenTelemetry service.name filter | (optional) defaults to undefined|
| **orgId** | [**string**] | Organization ID filter | (optional) defaults to undefined|
| **userId** | [**string**] | User ID filter | (optional) defaults to undefined|
| **boxId** | [**string**] | Box ID filter | (optional) defaults to undefined|
| **runnerId** | [**string**] | Runner ID filter | (optional) defaults to undefined|
| **machineId** | [**string**] | Machine or host ID filter | (optional) defaults to undefined|
| **traceId** | [**string**] | Trace ID filter | (optional) defaults to undefined|
| **requestId** | [**string**] | Request ID filter | (optional) defaults to undefined|
| **operationId** | [**string**] | Operation ID filter | (optional) defaults to undefined|
| **executionId** | [**string**] | Execution ID filter | (optional) defaults to undefined|
| **jobId** | [**string**] | Job ID filter | (optional) defaults to undefined|
| **severities** | **Array&lt;string&gt;** | Filter by severity levels (DEBUG, INFO, WARN, ERROR) | (optional) defaults to undefined|
| **search** | [**string**] | Search in log body | (optional) defaults to undefined|


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

# **adminGetObservabilityMetrics**
> MetricsResponse adminGetObservabilityMetrics()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let from: Date; //Start of time range (ISO 8601) (optional) (default to undefined)
let to: Date; //End of time range (ISO 8601) (optional) (default to undefined)
let page: number; //Page number (1-indexed) (optional) (default to 1)
let limit: number; //Number of items per page (optional) (default to 100)
let layer: 'api' | 'runner' | 'ec2_host' | 'box'; //Telemetry producer layer (optional) (default to undefined)
let serviceName: string; //OpenTelemetry service.name filter (optional) (default to undefined)
let orgId: string; //Organization ID filter (optional) (default to undefined)
let userId: string; //User ID filter (optional) (default to undefined)
let boxId: string; //Box ID filter (optional) (default to undefined)
let runnerId: string; //Runner ID filter (optional) (default to undefined)
let machineId: string; //Machine or host ID filter (optional) (default to undefined)
let traceId: string; //Trace ID filter (optional) (default to undefined)
let requestId: string; //Request ID filter (optional) (default to undefined)
let operationId: string; //Operation ID filter (optional) (default to undefined)
let executionId: string; //Execution ID filter (optional) (default to undefined)
let jobId: string; //Job ID filter (optional) (default to undefined)
let metricNames: Array<string>; //Filter by metric names (optional) (default to undefined)

const { status, data } = await apiInstance.adminGetObservabilityMetrics(
    from,
    to,
    page,
    limit,
    layer,
    serviceName,
    orgId,
    userId,
    boxId,
    runnerId,
    machineId,
    traceId,
    requestId,
    operationId,
    executionId,
    jobId,
    metricNames
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **from** | [**Date**] | Start of time range (ISO 8601) | (optional) defaults to undefined|
| **to** | [**Date**] | End of time range (ISO 8601) | (optional) defaults to undefined|
| **page** | [**number**] | Page number (1-indexed) | (optional) defaults to 1|
| **limit** | [**number**] | Number of items per page | (optional) defaults to 100|
| **layer** | [**&#39;api&#39; | &#39;runner&#39; | &#39;ec2_host&#39; | &#39;box&#39;**]**Array<&#39;api&#39; &#124; &#39;runner&#39; &#124; &#39;ec2_host&#39; &#124; &#39;box&#39; &#124; &#39;11184809&#39;>** | Telemetry producer layer | (optional) defaults to undefined|
| **serviceName** | [**string**] | OpenTelemetry service.name filter | (optional) defaults to undefined|
| **orgId** | [**string**] | Organization ID filter | (optional) defaults to undefined|
| **userId** | [**string**] | User ID filter | (optional) defaults to undefined|
| **boxId** | [**string**] | Box ID filter | (optional) defaults to undefined|
| **runnerId** | [**string**] | Runner ID filter | (optional) defaults to undefined|
| **machineId** | [**string**] | Machine or host ID filter | (optional) defaults to undefined|
| **traceId** | [**string**] | Trace ID filter | (optional) defaults to undefined|
| **requestId** | [**string**] | Request ID filter | (optional) defaults to undefined|
| **operationId** | [**string**] | Operation ID filter | (optional) defaults to undefined|
| **executionId** | [**string**] | Execution ID filter | (optional) defaults to undefined|
| **jobId** | [**string**] | Job ID filter | (optional) defaults to undefined|
| **metricNames** | **Array&lt;string&gt;** | Filter by metric names | (optional) defaults to undefined|


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

# **adminGetObservabilityStatus**
> AdminObservabilityStatusDto adminGetObservabilityStatus()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

const { status, data } = await apiInstance.adminGetObservabilityStatus();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**AdminObservabilityStatusDto**

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

# **adminGetObservabilityTraceSpans**
> Array<TraceSpan> adminGetObservabilityTraceSpans()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let traceId: string; // (default to undefined)
let from: Date; //Start of time range (ISO 8601) (optional) (default to undefined)
let to: Date; //End of time range (ISO 8601) (optional) (default to undefined)
let page: number; //Page number (1-indexed) (optional) (default to 1)
let limit: number; //Number of items per page (optional) (default to 100)
let layer: 'api' | 'runner' | 'ec2_host' | 'box'; //Telemetry producer layer (optional) (default to undefined)
let serviceName: string; //OpenTelemetry service.name filter (optional) (default to undefined)
let orgId: string; //Organization ID filter (optional) (default to undefined)
let userId: string; //User ID filter (optional) (default to undefined)
let boxId: string; //Box ID filter (optional) (default to undefined)
let runnerId: string; //Runner ID filter (optional) (default to undefined)
let machineId: string; //Machine or host ID filter (optional) (default to undefined)
let requestId: string; //Request ID filter (optional) (default to undefined)
let operationId: string; //Operation ID filter (optional) (default to undefined)
let executionId: string; //Execution ID filter (optional) (default to undefined)
let jobId: string; //Job ID filter (optional) (default to undefined)

const { status, data } = await apiInstance.adminGetObservabilityTraceSpans(
    traceId,
    from,
    to,
    page,
    limit,
    layer,
    serviceName,
    orgId,
    userId,
    boxId,
    runnerId,
    machineId,
    requestId,
    operationId,
    executionId,
    jobId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **traceId** | [**string**] |  | defaults to undefined|
| **from** | [**Date**] | Start of time range (ISO 8601) | (optional) defaults to undefined|
| **to** | [**Date**] | End of time range (ISO 8601) | (optional) defaults to undefined|
| **page** | [**number**] | Page number (1-indexed) | (optional) defaults to 1|
| **limit** | [**number**] | Number of items per page | (optional) defaults to 100|
| **layer** | [**&#39;api&#39; | &#39;runner&#39; | &#39;ec2_host&#39; | &#39;box&#39;**]**Array<&#39;api&#39; &#124; &#39;runner&#39; &#124; &#39;ec2_host&#39; &#124; &#39;box&#39; &#124; &#39;11184809&#39;>** | Telemetry producer layer | (optional) defaults to undefined|
| **serviceName** | [**string**] | OpenTelemetry service.name filter | (optional) defaults to undefined|
| **orgId** | [**string**] | Organization ID filter | (optional) defaults to undefined|
| **userId** | [**string**] | User ID filter | (optional) defaults to undefined|
| **boxId** | [**string**] | Box ID filter | (optional) defaults to undefined|
| **runnerId** | [**string**] | Runner ID filter | (optional) defaults to undefined|
| **machineId** | [**string**] | Machine or host ID filter | (optional) defaults to undefined|
| **requestId** | [**string**] | Request ID filter | (optional) defaults to undefined|
| **operationId** | [**string**] | Operation ID filter | (optional) defaults to undefined|
| **executionId** | [**string**] | Execution ID filter | (optional) defaults to undefined|
| **jobId** | [**string**] | Job ID filter | (optional) defaults to undefined|


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

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminGetObservabilityTraces**
> PaginatedTraces adminGetObservabilityTraces()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let from: Date; //Start of time range (ISO 8601) (optional) (default to undefined)
let to: Date; //End of time range (ISO 8601) (optional) (default to undefined)
let page: number; //Page number (1-indexed) (optional) (default to 1)
let limit: number; //Number of items per page (optional) (default to 100)
let layer: 'api' | 'runner' | 'ec2_host' | 'box'; //Telemetry producer layer (optional) (default to undefined)
let serviceName: string; //OpenTelemetry service.name filter (optional) (default to undefined)
let orgId: string; //Organization ID filter (optional) (default to undefined)
let userId: string; //User ID filter (optional) (default to undefined)
let boxId: string; //Box ID filter (optional) (default to undefined)
let runnerId: string; //Runner ID filter (optional) (default to undefined)
let machineId: string; //Machine or host ID filter (optional) (default to undefined)
let traceId: string; //Trace ID filter (optional) (default to undefined)
let requestId: string; //Request ID filter (optional) (default to undefined)
let operationId: string; //Operation ID filter (optional) (default to undefined)
let executionId: string; //Execution ID filter (optional) (default to undefined)
let jobId: string; //Job ID filter (optional) (default to undefined)

const { status, data } = await apiInstance.adminGetObservabilityTraces(
    from,
    to,
    page,
    limit,
    layer,
    serviceName,
    orgId,
    userId,
    boxId,
    runnerId,
    machineId,
    traceId,
    requestId,
    operationId,
    executionId,
    jobId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **from** | [**Date**] | Start of time range (ISO 8601) | (optional) defaults to undefined|
| **to** | [**Date**] | End of time range (ISO 8601) | (optional) defaults to undefined|
| **page** | [**number**] | Page number (1-indexed) | (optional) defaults to 1|
| **limit** | [**number**] | Number of items per page | (optional) defaults to 100|
| **layer** | [**&#39;api&#39; | &#39;runner&#39; | &#39;ec2_host&#39; | &#39;box&#39;**]**Array<&#39;api&#39; &#124; &#39;runner&#39; &#124; &#39;ec2_host&#39; &#124; &#39;box&#39; &#124; &#39;11184809&#39;>** | Telemetry producer layer | (optional) defaults to undefined|
| **serviceName** | [**string**] | OpenTelemetry service.name filter | (optional) defaults to undefined|
| **orgId** | [**string**] | Organization ID filter | (optional) defaults to undefined|
| **userId** | [**string**] | User ID filter | (optional) defaults to undefined|
| **boxId** | [**string**] | Box ID filter | (optional) defaults to undefined|
| **runnerId** | [**string**] | Runner ID filter | (optional) defaults to undefined|
| **machineId** | [**string**] | Machine or host ID filter | (optional) defaults to undefined|
| **traceId** | [**string**] | Trace ID filter | (optional) defaults to undefined|
| **requestId** | [**string**] | Request ID filter | (optional) defaults to undefined|
| **operationId** | [**string**] | Operation ID filter | (optional) defaults to undefined|
| **executionId** | [**string**] | Execution ID filter | (optional) defaults to undefined|
| **jobId** | [**string**] | Job ID filter | (optional) defaults to undefined|


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

# **adminGetOverview**
> AdminOverview adminGetOverview()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

const { status, data } = await apiInstance.adminGetOverview();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**AdminOverview**

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

# **adminGetRunnerById**
> AdminRunner adminGetRunnerById()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let id: string; //Runner ID (default to undefined)

const { status, data } = await apiInstance.adminGetRunnerById(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Runner ID | defaults to undefined|


### Return type

**AdminRunner**

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

# **adminInvestigateObservability**
> AdminObservabilityInvestigateResponse adminInvestigateObservability()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let from: Date; //Start of time range (ISO 8601) (optional) (default to undefined)
let to: Date; //End of time range (ISO 8601) (optional) (default to undefined)
let page: number; //Page number (1-indexed) (optional) (default to 1)
let limit: number; //Number of items per page (optional) (default to 100)
let layer: 'api' | 'runner' | 'ec2_host' | 'box'; //Telemetry producer layer (optional) (default to undefined)
let serviceName: string; //OpenTelemetry service.name filter (optional) (default to undefined)
let orgId: string; //Organization ID filter (optional) (default to undefined)
let userId: string; //User ID filter (optional) (default to undefined)
let boxId: string; //Box ID filter (optional) (default to undefined)
let runnerId: string; //Runner ID filter (optional) (default to undefined)
let machineId: string; //Machine or host ID filter (optional) (default to undefined)
let traceId: string; //Trace ID filter (optional) (default to undefined)
let requestId: string; //Request ID filter (optional) (default to undefined)
let operationId: string; //Operation ID filter (optional) (default to undefined)
let executionId: string; //Execution ID filter (optional) (default to undefined)
let jobId: string; //Job ID filter (optional) (default to undefined)

const { status, data } = await apiInstance.adminInvestigateObservability(
    from,
    to,
    page,
    limit,
    layer,
    serviceName,
    orgId,
    userId,
    boxId,
    runnerId,
    machineId,
    traceId,
    requestId,
    operationId,
    executionId,
    jobId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **from** | [**Date**] | Start of time range (ISO 8601) | (optional) defaults to undefined|
| **to** | [**Date**] | End of time range (ISO 8601) | (optional) defaults to undefined|
| **page** | [**number**] | Page number (1-indexed) | (optional) defaults to 1|
| **limit** | [**number**] | Number of items per page | (optional) defaults to 100|
| **layer** | [**&#39;api&#39; | &#39;runner&#39; | &#39;ec2_host&#39; | &#39;box&#39;**]**Array<&#39;api&#39; &#124; &#39;runner&#39; &#124; &#39;ec2_host&#39; &#124; &#39;box&#39; &#124; &#39;11184809&#39;>** | Telemetry producer layer | (optional) defaults to undefined|
| **serviceName** | [**string**] | OpenTelemetry service.name filter | (optional) defaults to undefined|
| **orgId** | [**string**] | Organization ID filter | (optional) defaults to undefined|
| **userId** | [**string**] | User ID filter | (optional) defaults to undefined|
| **boxId** | [**string**] | Box ID filter | (optional) defaults to undefined|
| **runnerId** | [**string**] | Runner ID filter | (optional) defaults to undefined|
| **machineId** | [**string**] | Machine or host ID filter | (optional) defaults to undefined|
| **traceId** | [**string**] | Trace ID filter | (optional) defaults to undefined|
| **requestId** | [**string**] | Request ID filter | (optional) defaults to undefined|
| **operationId** | [**string**] | Operation ID filter | (optional) defaults to undefined|
| **executionId** | [**string**] | Execution ID filter | (optional) defaults to undefined|
| **jobId** | [**string**] | Job ID filter | (optional) defaults to undefined|


### Return type

**AdminObservabilityInvestigateResponse**

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

# **adminListBoxes**
> Array<AdminBoxItem> adminListBoxes()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

const { status, data } = await apiInstance.adminListBoxes();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**Array<AdminBoxItem>**

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

# **adminListMachines**
> Array<AdminMachineItem> adminListMachines()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

const { status, data } = await apiInstance.adminListMachines();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**Array<AdminMachineItem>**

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

# **adminListRunners**
> Array<AdminRunner> adminListRunners()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let regionId: string; //Filter runners by region ID (optional) (default to undefined)

const { status, data } = await apiInstance.adminListRunners(
    regionId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **regionId** | [**string**] | Filter runners by region ID | (optional) defaults to undefined|


### Return type

**Array<AdminRunner>**

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

# **adminListRunnersOverview**
> Array<AdminRunnerItem> adminListRunnersOverview()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

const { status, data } = await apiInstance.adminListRunnersOverview();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**Array<AdminRunnerItem>**

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

# **adminListUsers**
> Array<AdminUserItem> adminListUsers()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

const { status, data } = await apiInstance.adminListUsers();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**Array<AdminUserItem>**

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

# **adminReconcileBilling**
> adminReconcileBilling()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

const { status, data } = await apiInstance.adminReconcileBilling();
```

### Parameters
This endpoint does not have any parameters.


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

# **adminReconcileSetup**
> adminReconcileSetup()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let organizationId: string; // (default to undefined)

const { status, data } = await apiInstance.adminReconcileSetup(
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

# **adminReconcileTopUp**
> adminReconcileTopUp()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let topUpId: string; // (default to undefined)

const { status, data } = await apiInstance.adminReconcileTopUp(
    topUpId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **topUpId** | [**string**] |  | defaults to undefined|


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

# **adminRecoverBox**
> Box adminRecoverBox()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let boxId: string; //ID of the box (default to undefined)

const { status, data } = await apiInstance.adminRecoverBox(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | defaults to undefined|


### Return type

**Box**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Recovery initiated |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminUpdateRunnerScheduling**
> adminUpdateRunnerScheduling()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let id: string; // (default to undefined)

const { status, data } = await apiInstance.adminUpdateRunnerScheduling(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] |  | defaults to undefined|


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
|**204** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

