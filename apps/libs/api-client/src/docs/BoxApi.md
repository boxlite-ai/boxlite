# BoxApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**expireSignedPortPreviewUrl**](#expiresignedportpreviewurl) | **POST** /box/{boxIdOrName}/ports/{port}/signed-preview-url/{token}/expire | Expire signed preview URL for a box port|
|[**getBox**](#getbox) | **GET** /box/{boxIdOrName} | Get box details|
|[**getBoxLogs**](#getboxlogs) | **GET** /box/{boxId}/telemetry/logs | Get box logs|
|[**getBoxMetrics**](#getboxmetrics) | **GET** /box/{boxId}/telemetry/metrics | Get box metrics|
|[**getBoxTraceSpans**](#getboxtracespans) | **GET** /box/{boxId}/telemetry/traces/{traceId} | Get trace spans|
|[**getBoxTraces**](#getboxtraces) | **GET** /box/{boxId}/telemetry/traces | Get box traces|
|[**getBoxesForRunner**](#getboxesforrunner) | **GET** /box/for-runner | Get boxes for the authenticated runner|
|[**getPortPreviewUrl**](#getportpreviewurl) | **GET** /box/{boxIdOrName}/ports/{port}/preview-url | Get preview URL for a box port|
|[**getSignedPortPreviewUrl**](#getsignedportpreviewurl) | **GET** /box/{boxIdOrName}/ports/{port}/signed-preview-url | Get signed preview URL for a box port|
|[**getToolboxProxyUrl**](#gettoolboxproxyurl) | **GET** /box/{boxId}/toolbox-proxy-url | Get toolbox proxy URL for a box|
|[**listBoxes**](#listboxes) | **GET** /box | List all boxes|
|[**listBoxesPaginated**](#listboxespaginated) | **GET** /box/paginated | List all boxes paginated|
|[**recoverBox**](#recoverbox) | **POST** /box/{boxIdOrName}/recover | Recover box from error state|
|[**replaceLabels**](#replacelabels) | **PUT** /box/{boxIdOrName}/labels | Replace box labels|
|[**setAutoDeleteInterval**](#setautodeleteinterval) | **POST** /box/{boxIdOrName}/autodelete/{interval} | Set box auto-delete interval|
|[**setAutostopInterval**](#setautostopinterval) | **POST** /box/{boxIdOrName}/autostop/{interval} | Set box auto-stop interval|
|[**updateBoxState**](#updateboxstate) | **PUT** /box/{boxId}/state | Update box state|
|[**updateLastActivity**](#updatelastactivity) | **POST** /box/{boxId}/last-activity | Update box last activity|
|[**updatePublicStatus**](#updatepublicstatus) | **POST** /box/{boxIdOrName}/public/{isPublic} | Update public status|

# **expireSignedPortPreviewUrl**
> expireSignedPortPreviewUrl()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxIdOrName: string; //ID or name of the box
let port: number; //Port number to expire signed preview URL for
let token: string; //Token to expire signed preview URL for
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.expireSignedPortPreviewUrl(
    boxIdOrName,
    port,
    token,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | |
| **port** | [**number**] | Port number to expire signed preview URL for | |
| **token** | [**string**] | Token to expire signed preview URL for | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


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
|**200** | Signed preview URL has been expired |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getBox**
> Box getBox()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxIdOrName: string; //ID or name of the box
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let verbose: boolean; //Include verbose output (optional) (default to undefined)

const { status, data } = await apiInstance.getBox(
    boxIdOrName,
    xBoxLiteOrganizationID,
    verbose
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **verbose** | [**boolean**] | Include verbose output | (optional) defaults to undefined|


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
|**200** | Box details |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getBoxLogs**
> PaginatedLogs getBoxLogs()

Retrieve OTEL logs for a box within a time range

### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //ID of the box
let from: Date; //Start of time range (ISO 8601)
let to: Date; //End of time range (ISO 8601)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let page: number; //Page number (1-indexed) (optional) (default to 1)
let limit: number; //Number of items per page (optional) (default to 100)
let severities: Array<string>; //Filter by severity levels (DEBUG, INFO, WARN, ERROR) (optional) (default to undefined)
let search: string; //Search in log body (optional) (default to undefined)

const { status, data } = await apiInstance.getBoxLogs(
    boxId,
    from,
    to,
    xBoxLiteOrganizationID,
    page,
    limit,
    severities,
    search
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | |
| **from** | [**Date**] | Start of time range (ISO 8601) | |
| **to** | [**Date**] | End of time range (ISO 8601) | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **page** | [**number**] | Page number (1-indexed) | (optional) defaults to 1|
| **limit** | [**number**] | Number of items per page | (optional) defaults to 100|
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
|**200** | Paginated list of log entries |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getBoxMetrics**
> MetricsResponse getBoxMetrics()

Retrieve OTEL metrics for a box within a time range

### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //ID of the box
let from: Date; //Start of time range (ISO 8601)
let to: Date; //End of time range (ISO 8601)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let metricNames: Array<string>; //Filter by metric names (optional) (default to undefined)

const { status, data } = await apiInstance.getBoxMetrics(
    boxId,
    from,
    to,
    xBoxLiteOrganizationID,
    metricNames
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | |
| **from** | [**Date**] | Start of time range (ISO 8601) | |
| **to** | [**Date**] | End of time range (ISO 8601) | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
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
|**200** | Metrics time series data |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getBoxTraceSpans**
> Array<TraceSpan> getBoxTraceSpans()

Retrieve all spans for a specific trace

### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //ID of the box
let traceId: string; //ID of the trace
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getBoxTraceSpans(
    boxId,
    traceId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | |
| **traceId** | [**string**] | ID of the trace | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


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
|**200** | List of spans in the trace |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getBoxTraces**
> PaginatedTraces getBoxTraces()

Retrieve OTEL traces for a box within a time range

### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //ID of the box
let from: Date; //Start of time range (ISO 8601)
let to: Date; //End of time range (ISO 8601)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let page: number; //Page number (1-indexed) (optional) (default to 1)
let limit: number; //Number of items per page (optional) (default to 100)

const { status, data } = await apiInstance.getBoxTraces(
    boxId,
    from,
    to,
    xBoxLiteOrganizationID,
    page,
    limit
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | |
| **from** | [**Date**] | Start of time range (ISO 8601) | |
| **to** | [**Date**] | End of time range (ISO 8601) | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **page** | [**number**] | Page number (1-indexed) | (optional) defaults to 1|
| **limit** | [**number**] | Number of items per page | (optional) defaults to 100|


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
|**200** | Paginated list of trace summaries |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getBoxesForRunner**
> Array<Box> getBoxesForRunner()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let states: string; //Comma-separated list of box states to filter by (optional) (default to undefined)
let skipReconcilingBoxes: boolean; //Skip boxes where state differs from desired state (optional) (default to undefined)

const { status, data } = await apiInstance.getBoxesForRunner(
    xBoxLiteOrganizationID,
    states,
    skipReconcilingBoxes
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **states** | [**string**] | Comma-separated list of box states to filter by | (optional) defaults to undefined|
| **skipReconcilingBoxes** | [**boolean**] | Skip boxes where state differs from desired state | (optional) defaults to undefined|


### Return type

**Array<Box>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of boxes for the authenticated runner |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getPortPreviewUrl**
> PortPreviewUrl getPortPreviewUrl()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxIdOrName: string; //ID or name of the box
let port: number; //Port number to get preview URL for
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getPortPreviewUrl(
    boxIdOrName,
    port,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | |
| **port** | [**number**] | Port number to get preview URL for | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**PortPreviewUrl**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Preview URL for the specified port |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getSignedPortPreviewUrl**
> SignedPortPreviewUrl getSignedPortPreviewUrl()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxIdOrName: string; //ID or name of the box
let port: number; //Port number to get signed preview URL for
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let expiresInSeconds: number; //Expiration time in seconds (default: 60 seconds) (optional) (default to undefined)

const { status, data } = await apiInstance.getSignedPortPreviewUrl(
    boxIdOrName,
    port,
    xBoxLiteOrganizationID,
    expiresInSeconds
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | |
| **port** | [**number**] | Port number to get signed preview URL for | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **expiresInSeconds** | [**number**] | Expiration time in seconds (default: 60 seconds) | (optional) defaults to undefined|


### Return type

**SignedPortPreviewUrl**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Signed preview URL for the specified port |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getToolboxProxyUrl**
> ToolboxProxyUrl getToolboxProxyUrl()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //ID of the box
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getToolboxProxyUrl(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ToolboxProxyUrl**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Toolbox proxy URL for the specified box |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listBoxes**
> Array<Box> listBoxes()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let verbose: boolean; //Include verbose output (optional) (default to undefined)
let labels: string; //JSON encoded labels to filter by (optional) (default to undefined)
let includeErroredDeleted: boolean; //Include errored and deleted boxes (optional) (default to undefined)

const { status, data } = await apiInstance.listBoxes(
    xBoxLiteOrganizationID,
    verbose,
    labels,
    includeErroredDeleted
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **verbose** | [**boolean**] | Include verbose output | (optional) defaults to undefined|
| **labels** | [**string**] | JSON encoded labels to filter by | (optional) defaults to undefined|
| **includeErroredDeleted** | [**boolean**] | Include errored and deleted boxes | (optional) defaults to undefined|


### Return type

**Array<Box>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of all boxes |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listBoxesPaginated**
> PaginatedBoxes listBoxesPaginated()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let page: number; //Page number of the results (optional) (default to 1)
let limit: number; //Number of results per page (optional) (default to 100)
let id: string; //Filter by partial Box ID or name match (optional) (default to undefined)
let name: string; //Filter by partial name match (optional) (default to undefined)
let labels: string; //JSON encoded labels to filter by (optional) (default to undefined)
let includeErroredDeleted: boolean; //Include results with errored state and deleted desired state (optional) (default to false)
let states: Array<'creating' | 'restoring' | 'destroying' | 'started' | 'stopped' | 'starting' | 'stopping' | 'error' | 'unknown' | 'archived' | 'archiving' | 'resizing'>; //List of states to filter by (optional) (default to undefined)
let regions: Array<string>; //List of regions to filter by (optional) (default to undefined)
let minCpu: number; //Minimum CPU (optional) (default to undefined)
let maxCpu: number; //Maximum CPU (optional) (default to undefined)
let minMemoryGiB: number; //Minimum memory in GiB (optional) (default to undefined)
let maxMemoryGiB: number; //Maximum memory in GiB (optional) (default to undefined)
let minDiskGiB: number; //Minimum disk space in GiB (optional) (default to undefined)
let maxDiskGiB: number; //Maximum disk space in GiB (optional) (default to undefined)
let lastEventAfter: Date; //Include items with last event after this timestamp (optional) (default to undefined)
let lastEventBefore: Date; //Include items with last event before this timestamp (optional) (default to undefined)
let sort: 'id' | 'name' | 'state' | 'region' | 'updatedAt' | 'createdAt'; //Field to sort by (optional) (default to 'createdAt')
let order: 'asc' | 'desc'; //Direction to sort by (optional) (default to 'desc')

const { status, data } = await apiInstance.listBoxesPaginated(
    xBoxLiteOrganizationID,
    page,
    limit,
    id,
    name,
    labels,
    includeErroredDeleted,
    states,
    regions,
    minCpu,
    maxCpu,
    minMemoryGiB,
    maxMemoryGiB,
    minDiskGiB,
    maxDiskGiB,
    lastEventAfter,
    lastEventBefore,
    sort,
    order
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **page** | [**number**] | Page number of the results | (optional) defaults to 1|
| **limit** | [**number**] | Number of results per page | (optional) defaults to 100|
| **id** | [**string**] | Filter by partial Box ID or name match | (optional) defaults to undefined|
| **name** | [**string**] | Filter by partial name match | (optional) defaults to undefined|
| **labels** | [**string**] | JSON encoded labels to filter by | (optional) defaults to undefined|
| **includeErroredDeleted** | [**boolean**] | Include results with errored state and deleted desired state | (optional) defaults to false|
| **states** | **Array<&#39;creating&#39; &#124; &#39;restoring&#39; &#124; &#39;destroying&#39; &#124; &#39;started&#39; &#124; &#39;stopped&#39; &#124; &#39;starting&#39; &#124; &#39;stopping&#39; &#124; &#39;error&#39; &#124; &#39;unknown&#39; &#124; &#39;archived&#39; &#124; &#39;archiving&#39; &#124; &#39;resizing&#39;>** | List of states to filter by | (optional) defaults to undefined|
| **regions** | **Array&lt;string&gt;** | List of regions to filter by | (optional) defaults to undefined|
| **minCpu** | [**number**] | Minimum CPU | (optional) defaults to undefined|
| **maxCpu** | [**number**] | Maximum CPU | (optional) defaults to undefined|
| **minMemoryGiB** | [**number**] | Minimum memory in GiB | (optional) defaults to undefined|
| **maxMemoryGiB** | [**number**] | Maximum memory in GiB | (optional) defaults to undefined|
| **minDiskGiB** | [**number**] | Minimum disk space in GiB | (optional) defaults to undefined|
| **maxDiskGiB** | [**number**] | Maximum disk space in GiB | (optional) defaults to undefined|
| **lastEventAfter** | [**Date**] | Include items with last event after this timestamp | (optional) defaults to undefined|
| **lastEventBefore** | [**Date**] | Include items with last event before this timestamp | (optional) defaults to undefined|
| **sort** | [**&#39;id&#39; &#124; &#39;name&#39; &#124; &#39;state&#39; &#124; &#39;region&#39; &#124; &#39;updatedAt&#39; &#124; &#39;createdAt&#39;**] | Field to sort by | (optional) defaults to 'createdAt'|
| **order** | [**&#39;asc&#39; &#124; &#39;desc&#39;**] | Direction to sort by | (optional) defaults to 'desc'|


### Return type

**PaginatedBoxes**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Paginated list of all boxes |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **recoverBox**
> Box recoverBox()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxIdOrName: string; //ID or name of the box
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.recoverBox(
    boxIdOrName,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


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

# **replaceLabels**
> BoxLabels replaceLabels(boxLabels)


### Example

```typescript
import {
    BoxApi,
    Configuration,
    BoxLabels
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxIdOrName: string; //ID or name of the box
let boxLabels: BoxLabels; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.replaceLabels(
    boxIdOrName,
    boxLabels,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxLabels** | **BoxLabels**|  | |
| **boxIdOrName** | [**string**] | ID or name of the box | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**BoxLabels**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Labels have been successfully replaced |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **setAutoDeleteInterval**
> Box setAutoDeleteInterval()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxIdOrName: string; //ID or name of the box
let interval: number; //Auto-delete interval in minutes (negative value or 0 disables). Converted to seconds and stored as auto-delete interval; 0 disables auto-delete.
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.setAutoDeleteInterval(
    boxIdOrName,
    interval,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | |
| **interval** | [**number**] | Auto-delete interval in minutes (negative value or 0 disables). Converted to seconds and stored as auto-delete interval; 0 disables auto-delete. | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


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
|**200** | Auto-delete interval has been set |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **setAutostopInterval**
> Box setAutostopInterval()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxIdOrName: string; //ID or name of the box
let interval: number; //Auto-stop interval in minutes (0 to disable). Converted to seconds and stored as auto-stop interval.
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.setAutostopInterval(
    boxIdOrName,
    interval,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | |
| **interval** | [**number**] | Auto-stop interval in minutes (0 to disable). Converted to seconds and stored as auto-stop interval. | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


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
|**200** | Auto-stop interval has been set |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateBoxState**
> updateBoxState(updateBoxStateDto)


### Example

```typescript
import {
    BoxApi,
    Configuration,
    UpdateBoxStateDto
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //ID of the box
let updateBoxStateDto: UpdateBoxStateDto; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.updateBoxState(
    boxId,
    updateBoxStateDto,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **updateBoxStateDto** | **UpdateBoxStateDto**|  | |
| **boxId** | [**string**] | ID of the box | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


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
|**200** | Box state has been successfully updated |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateLastActivity**
> updateLastActivity()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxId: string; //ID of the box
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.updateLastActivity(
    boxId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


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
|**201** | Last activity has been updated |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updatePublicStatus**
> Box updatePublicStatus()


### Example

```typescript
import {
    BoxApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxIdOrName: string; //ID or name of the box
let isPublic: boolean; //Public status to set
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.updatePublicStatus(
    boxIdOrName,
    isPublic,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxIdOrName** | [**string**] | ID or name of the box | |
| **isPublic** | [**boolean**] | Public status to set | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


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
|**200** | Public status has been successfully updated |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

