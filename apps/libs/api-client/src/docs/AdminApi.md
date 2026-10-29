# AdminApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**adminCreateRunner**](#admincreaterunner) | **POST** /admin/runners | Create runner|
|[**adminDeleteRunner**](#admindeleterunner) | **DELETE** /admin/runners/{id} | Delete runner|
|[**adminGetBoxOverview**](#admingetboxoverview) | **GET** /admin/boxes/{id} | Get box placement, health, and jobs|
|[**adminGetComponentIdentities**](#admingetcomponentidentities) | **GET** /admin/component-identities | Get API and runner version identities|
|[**adminGetJobOverview**](#admingetjoboverview) | **GET** /admin/jobs/{id} | Get a job with sanitized failure category|
|[**adminGetOrganizationOverview**](#admingetorganizationoverview) | **GET** /admin/organizations/{organizationId} | Get organization operational detail|
|[**adminGetRegion**](#admingetregion) | **GET** /admin/regions/{id} | Get region capacity and health|
|[**adminGetRunnerById**](#admingetrunnerbyid) | **GET** /admin/runners/{id} | Get runner by ID|
|[**adminListBoxesOverview**](#adminlistboxesoverview) | **GET** /admin/boxes | List boxes with placement and health|
|[**adminListJobsOverview**](#adminlistjobsoverview) | **GET** /admin/jobs | List jobs with sanitized failure categories|
|[**adminListOrganizationsOverview**](#adminlistorganizationsoverview) | **GET** /admin/organizations | List organization operational summaries|
|[**adminListRegions**](#adminlistregions) | **GET** /admin/regions | List regions with capacity and health|
|[**adminListRunnerCpuIncidents**](#adminlistrunnercpuincidents) | **GET** /admin/runner-cpu-incidents | Query sustained runner CPU incidents by capture completion time range|
|[**adminListRunners**](#adminlistrunners) | **GET** /admin/runners | List all runners|
|[**adminQueryUsage**](#adminqueryusage) | **GET** /admin/usage | Query recorded resource usage with fixed snapshot pagination|
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

let id: string; //Runner ID

const { status, data } = await apiInstance.adminDeleteRunner(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Runner ID | |


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

# **adminGetBoxOverview**
> AdminBoxDetail adminGetBoxOverview()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let id: string; //Box ID
let jobCursor: string; //Opaque job page cursor (optional) (default to undefined)
let sectionLimit: number; // (optional) (default to undefined)

const { status, data } = await apiInstance.adminGetBoxOverview(
    id,
    jobCursor,
    sectionLimit
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Box ID | |
| **jobCursor** | [**string**] | Opaque job page cursor | (optional) defaults to undefined|
| **sectionLimit** | [**number**] |  | (optional) defaults to undefined|


### Return type

**AdminBoxDetail**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**400** | Invalid cursor or section limit |  -  |
|**404** | Box not found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminGetComponentIdentities**
> AdminComponentIdentities adminGetComponentIdentities()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

const { status, data } = await apiInstance.adminGetComponentIdentities();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**AdminComponentIdentities**

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

# **adminGetJobOverview**
> AdminJobOverview adminGetJobOverview()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let id: string; //Job ID

const { status, data } = await apiInstance.adminGetJobOverview(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Job ID | |


### Return type

**AdminJobOverview**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**404** | Job not found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminGetOrganizationOverview**
> AdminOrganizationDetail adminGetOrganizationOverview()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let organizationId: string; //Organization ID
let memberCursor: string; //Opaque member page cursor (optional) (default to undefined)
let boxCursor: string; //Opaque box page cursor (optional) (default to undefined)
let sectionLimit: number; // (optional) (default to undefined)
let include: string; //Comma-separated usage,activation. Omit to read neither section. (optional) (default to undefined)

const { status, data } = await apiInstance.adminGetOrganizationOverview(
    organizationId,
    memberCursor,
    boxCursor,
    sectionLimit,
    include
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] | Organization ID | |
| **memberCursor** | [**string**] | Opaque member page cursor | (optional) defaults to undefined|
| **boxCursor** | [**string**] | Opaque box page cursor | (optional) defaults to undefined|
| **sectionLimit** | [**number**] |  | (optional) defaults to undefined|
| **include** | [**string**] | Comma-separated usage,activation. Omit to read neither section. | (optional) defaults to undefined|


### Return type

**AdminOrganizationDetail**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**400** | Invalid cursor or section limit |  -  |
|**404** | Organization not found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminGetRegion**
> AdminRegionOverview adminGetRegion()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let id: string; //Region ID

const { status, data } = await apiInstance.adminGetRegion(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Region ID | |


### Return type

**AdminRegionOverview**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**404** | Region not found |  -  |

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

let id: string; //Runner ID

const { status, data } = await apiInstance.adminGetRunnerById(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Runner ID | |


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

# **adminListBoxesOverview**
> AdminBoxOverviewPage adminListBoxesOverview()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let cursor: string; //Opaque cursor returned by the previous page (optional) (default to undefined)
let limit: number; // (optional) (default to undefined)

const { status, data } = await apiInstance.adminListBoxesOverview(
    cursor,
    limit
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **cursor** | [**string**] | Opaque cursor returned by the previous page | (optional) defaults to undefined|
| **limit** | [**number**] |  | (optional) defaults to undefined|


### Return type

**AdminBoxOverviewPage**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**400** | Invalid cursor or limit |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminListJobsOverview**
> AdminJobOverviewPage adminListJobsOverview()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let cursor: string; //Opaque cursor returned by the previous page (optional) (default to undefined)
let limit: number; // (optional) (default to undefined)

const { status, data } = await apiInstance.adminListJobsOverview(
    cursor,
    limit
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **cursor** | [**string**] | Opaque cursor returned by the previous page | (optional) defaults to undefined|
| **limit** | [**number**] |  | (optional) defaults to undefined|


### Return type

**AdminJobOverviewPage**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**400** | Invalid cursor or limit |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminListOrganizationsOverview**
> AdminOrganizationOverviewPage adminListOrganizationsOverview()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let q: string; //Organization ID or name (optional) (default to undefined)
let cursor: string; //Opaque cursor returned by the previous page (optional) (default to undefined)
let limit: number; // (optional) (default to undefined)
let createdTo: string; //Exclusive RFC 3339 instant, at most milliseconds. (optional) (default to undefined)
let createdFrom: string; //Inclusive RFC 3339 instant, at most milliseconds. (optional) (default to undefined)

const { status, data } = await apiInstance.adminListOrganizationsOverview(
    q,
    cursor,
    limit,
    createdTo,
    createdFrom
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **q** | [**string**] | Organization ID or name | (optional) defaults to undefined|
| **cursor** | [**string**] | Opaque cursor returned by the previous page | (optional) defaults to undefined|
| **limit** | [**number**] |  | (optional) defaults to undefined|
| **createdTo** | [**string**] | Exclusive RFC 3339 instant, at most milliseconds. | (optional) defaults to undefined|
| **createdFrom** | [**string**] | Inclusive RFC 3339 instant, at most milliseconds. | (optional) defaults to undefined|


### Return type

**AdminOrganizationOverviewPage**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**400** | Invalid cursor or limit |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminListRegions**
> AdminRegionOverviewPage adminListRegions()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let cursor: string; //Opaque cursor returned by the previous page (optional) (default to undefined)
let limit: number; // (optional) (default to undefined)

const { status, data } = await apiInstance.adminListRegions(
    cursor,
    limit
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **cursor** | [**string**] | Opaque cursor returned by the previous page | (optional) defaults to undefined|
| **limit** | [**number**] |  | (optional) defaults to undefined|


### Return type

**AdminRegionOverviewPage**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**400** | Invalid cursor or limit |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminListRunnerCpuIncidents**
> CpuIncidentListDto adminListRunnerCpuIncidents()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let from: Date; //Inclusive capture completion time, with timezone.
let to: Date; //Exclusive capture completion time, with timezone; must follow from.
let limit: number; //Maximum rows, ordered by ID ascending. (optional) (default to 50)
let runnerId: string; // (optional) (default to undefined)

const { status, data } = await apiInstance.adminListRunnerCpuIncidents(
    from,
    to,
    limit,
    runnerId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **from** | [**Date**] | Inclusive capture completion time, with timezone. | |
| **to** | [**Date**] | Exclusive capture completion time, with timezone; must follow from. | |
| **limit** | [**number**] | Maximum rows, ordered by ID ascending. | (optional) defaults to 50|
| **runnerId** | [**string**] |  | (optional) defaults to undefined|


### Return type

**CpuIncidentListDto**

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

# **adminQueryUsage**
> AdminUsagePage adminQueryUsage()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let to: string; //Exclusive RFC 3339 instant, no later than now.
let from: string; //Inclusive RFC 3339 instant, at most milliseconds.
let xUsageSnapshotOwner: string; //Optional 64 lowercase hex caller partition; never authentication. (optional) (default to undefined)
let cursor: string; // (optional) (default to undefined)
let limit: number; // (optional) (default to undefined)
let boxId: string; // (optional) (default to undefined)
let regionId: string; // (optional) (default to undefined)
let organizationId: string; // (optional) (default to undefined)
let groupBy: string; //One or two of organizationId,regionId,boxId, comma-separated. (optional) (default to undefined)
let metrics: string; //Comma-separated computeVcpuSeconds,storageByteSeconds,memoryGibSeconds. (optional) (default to undefined)
let granularity: 'window' | 'hour' | 'day'; // (optional) (default to undefined)

const { status, data } = await apiInstance.adminQueryUsage(
    to,
    from,
    xUsageSnapshotOwner,
    cursor,
    limit,
    boxId,
    regionId,
    organizationId,
    groupBy,
    metrics,
    granularity
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **to** | [**string**] | Exclusive RFC 3339 instant, no later than now. | |
| **from** | [**string**] | Inclusive RFC 3339 instant, at most milliseconds. | |
| **xUsageSnapshotOwner** | [**string**] | Optional 64 lowercase hex caller partition; never authentication. | (optional) defaults to undefined|
| **cursor** | [**string**] |  | (optional) defaults to undefined|
| **limit** | [**number**] |  | (optional) defaults to undefined|
| **boxId** | [**string**] |  | (optional) defaults to undefined|
| **regionId** | [**string**] |  | (optional) defaults to undefined|
| **organizationId** | [**string**] |  | (optional) defaults to undefined|
| **groupBy** | [**string**] | One or two of organizationId,regionId,boxId, comma-separated. | (optional) defaults to undefined|
| **metrics** | [**string**] | Comma-separated computeVcpuSeconds,storageByteSeconds,memoryGibSeconds. | (optional) defaults to undefined|
| **granularity** | [**&#39;window&#39; &#124; &#39;hour&#39; &#124; &#39;day&#39;**] |  | (optional) defaults to undefined|


### Return type

**AdminUsagePage**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**400** | Invalid query or cursor binding |  -  |
|**410** | Snapshot expired; restart the complete query |  -  |
|**422** | Query exceeds a resource limit |  -  |
|**503** | Database or snapshot cache unavailable |  -  |

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

let boxId: string; //ID of the box

const { status, data } = await apiInstance.adminRecoverBox(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] | ID of the box | |


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

let id: string; //

const { status, data } = await apiInstance.adminUpdateRunnerScheduling(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] |  | |


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

