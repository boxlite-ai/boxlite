# AdminApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**adminCreateCiConnection**](#admincreateciconnection) | **POST** /admin/organizations/{organizationId}/ci/connections | Bind an installed GitHub CI App to a billing organization|
|[**adminCreateRunner**](#admincreaterunner) | **POST** /admin/runners | Create runner|
|[**adminDeleteCiConnection**](#admindeleteciconnection) | **DELETE** /admin/organizations/{organizationId}/ci/connections/{bindingId} | Disable a CI connection with an observed version|
|[**adminDeleteRunner**](#admindeleterunner) | **DELETE** /admin/runners/{id} | Delete runner|
|[**adminGetBoxOverview**](#admingetboxoverview) | **GET** /admin/boxes/{id} | Get box placement, health, and jobs|
|[**adminGetComponentIdentities**](#admingetcomponentidentities) | **GET** /admin/component-identities | Get API and runner version identities|
|[**adminGetJobOverview**](#admingetjoboverview) | **GET** /admin/jobs/{id} | Get a job with sanitized failure category|
|[**adminGetOrganizationNestedVirtualization**](#admingetorganizationnestedvirtualization) | **GET** /admin/organizations/{organizationId}/nested-virtualization | Read organization nesting allowlist|
|[**adminGetOrganizationOverview**](#admingetorganizationoverview) | **GET** /admin/organizations/{organizationId} | Get organization operational detail|
|[**adminGetRegion**](#admingetregion) | **GET** /admin/regions/{id} | Get region capacity and health|
|[**adminGetRunnerById**](#admingetrunnerbyid) | **GET** /admin/runners/{id} | Get runner by ID|
|[**adminListBoxesOverview**](#adminlistboxesoverview) | **GET** /admin/boxes | List boxes with placement and health|
|[**adminListCiConnections**](#adminlistciconnections) | **GET** /admin/organizations/{organizationId}/ci/connections | List retained CI connections for an organization|
|[**adminListJobsOverview**](#adminlistjobsoverview) | **GET** /admin/jobs | List jobs with sanitized failure categories|
|[**adminListOrganizationsOverview**](#adminlistorganizationsoverview) | **GET** /admin/organizations | List organization operational summaries|
|[**adminListRegions**](#adminlistregions) | **GET** /admin/regions | List regions with capacity and health|
|[**adminListRunnerCpuIncidents**](#adminlistrunnercpuincidents) | **GET** /admin/runner-cpu-incidents | Query sustained runner CPU incidents by capture completion time range|
|[**adminListRunnerMemoryIncidents**](#adminlistrunnermemoryincidents) | **GET** /admin/runner-memory-incidents | Query runner memory snapshots by host sample time range|
|[**adminListRunners**](#adminlistrunners) | **GET** /admin/runners | List all runners|
|[**adminLookupCiConnections**](#adminlookupciconnections) | **GET** /admin/ci/connections | Find CI billing destinations for an exact GitHub account|
|[**adminQueryUsage**](#adminqueryusage) | **GET** /admin/usage | Query recorded resource usage with fixed snapshot pagination|
|[**adminRecoverBox**](#adminrecoverbox) | **POST** /admin/box/{boxId}/recover | Recover box from error state as an admin|
|[**adminSetOrganizationNestedVirtualization**](#adminsetorganizationnestedvirtualization) | **PUT** /admin/organizations/{organizationId}/nested-virtualization | Set organization nesting allowlist|
|[**adminUpdateCiConnection**](#adminupdateciconnection) | **PATCH** /admin/organizations/{organizationId}/ci/connections/{bindingId} | Update CI private-repository policy with an observed version|
|[**adminUpdateRunnerScheduling**](#adminupdaterunnerscheduling) | **PATCH** /admin/runners/{id}/scheduling | Update runner scheduling status|

# **adminCreateCiConnection**
> AdminCiConnection adminCreateCiConnection(adminCiConnectionCreate)

Uses App authentication, without GitHub user OAuth or either organization ownership. Defaults to conflict for any retained mapping. force:true requires observed expected_binding_id and expected_generation; omit both otherwise. New creation returns 201; replacement returns 200.

### Example

```typescript
import {
    AdminApi,
    Configuration,
    AdminCiConnectionCreate
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let organizationId: string; //
let adminCiConnectionCreate: AdminCiConnectionCreate; //

const { status, data } = await apiInstance.adminCreateCiConnection(
    organizationId,
    adminCiConnectionCreate
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **adminCiConnectionCreate** | **AdminCiConnectionCreate**|  | |
| **organizationId** | [**string**] |  | |


### Return type

**AdminCiConnection**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**201** |  |  -  |
|**400** | Invalid request or precondition fields. |  -  |
|**401** | Invalid credentials. |  -  |
|**403** | Current platform administrator authority is required. |  -  |
|**404** | Organization or connection not found. |  -  |
|**409** | Existing, ambiguous or stale mapping; inspect connection or connections when present and repeat lookup. |  -  |
|**502** | GitHub installation verification unavailable. |  -  |
|**503** | CI App unavailable or connection capacity exceeded. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

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

# **adminDeleteCiConnection**
> adminDeleteCiConnection(adminCiConnectionVersion)

The JSON body must contain expected_generation. Retains original workers and cleanup identities; stale versions return 409 without mutation.

### Example

```typescript
import {
    AdminApi,
    Configuration,
    AdminCiConnectionVersion
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let organizationId: string; //
let bindingId: string; //
let adminCiConnectionVersion: AdminCiConnectionVersion; //

const { status, data } = await apiInstance.adminDeleteCiConnection(
    organizationId,
    bindingId,
    adminCiConnectionVersion
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **adminCiConnectionVersion** | **AdminCiConnectionVersion**|  | |
| **organizationId** | [**string**] |  | |
| **bindingId** | [**string**] |  | |


### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**204** | Connection disabled; response body is empty. |  -  |
|**400** | Invalid request or precondition fields. |  -  |
|**401** | Invalid credentials. |  -  |
|**403** | Current platform administrator authority is required. |  -  |
|**404** | Organization or connection not found. |  -  |
|**409** | Existing, ambiguous or stale mapping; inspect connection or connections when present and repeat lookup. |  -  |

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

# **adminGetOrganizationNestedVirtualization**
> AdminOrganizationNestedVirtualization adminGetOrganizationNestedVirtualization()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let organizationId: string; //

const { status, data } = await apiInstance.adminGetOrganizationNestedVirtualization(
    organizationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | |


### Return type

**AdminOrganizationNestedVirtualization**

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

# **adminListCiConnections**
> AdminCiConnectionPage adminListCiConnections()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let organizationId: string; //
let cursor: string; //Last binding ID from the previous page. (optional) (default to undefined)
let limit: number; // (optional) (default to 25)

const { status, data } = await apiInstance.adminListCiConnections(
    organizationId,
    cursor,
    limit
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **organizationId** | [**string**] |  | |
| **cursor** | [**string**] | Last binding ID from the previous page. | (optional) defaults to undefined|
| **limit** | [**number**] |  | (optional) defaults to 25|


### Return type

**AdminCiConnectionPage**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**400** | Invalid request or precondition fields. |  -  |
|**401** | Invalid credentials. |  -  |
|**403** | Current platform administrator authority is required. |  -  |
|**404** | Organization or connection not found. |  -  |
|**409** | Existing, ambiguous or stale mapping; inspect connection or connections when present and repeat lookup. |  -  |

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
let boxCountScope: 'all'; //Count every retained Box state; omit to keep the existing active-state count. (optional) (default to undefined)
let organizationId: string; //Exact organization UUID; avoids name search and cannot be combined with q. (optional) (default to undefined)
let include: 'memberEmails'; //Add up to 200 member emails to each organization; omit to keep the existing fields. (optional) (default to undefined)

const { status, data } = await apiInstance.adminListOrganizationsOverview(
    q,
    cursor,
    limit,
    createdTo,
    createdFrom,
    boxCountScope,
    organizationId,
    include
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
| **boxCountScope** | [**&#39;all&#39;**] | Count every retained Box state; omit to keep the existing active-state count. | (optional) defaults to undefined|
| **organizationId** | [**string**] | Exact organization UUID; avoids name search and cannot be combined with q. | (optional) defaults to undefined|
| **include** | [**&#39;memberEmails&#39;**] | Add up to 200 member emails to each organization; omit to keep the existing fields. | (optional) defaults to undefined|


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
let limit: number; //Maximum rows after per-Box maximum CPU-seconds selection, ordered by ID ascending. (optional) (default to 50)
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
| **limit** | [**number**] | Maximum rows after per-Box maximum CPU-seconds selection, ordered by ID ascending. | (optional) defaults to 50|
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

# **adminListRunnerMemoryIncidents**
> MemoryIncidentListDto adminListRunnerMemoryIncidents()


### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let from: Date; //Inclusive host sample time, with timezone.
let to: Date; //Exclusive host sample time, after from.
let limit: number; //Maximum snapshots after per-Box maximum memory selection, ordered by ID ascending. (optional) (default to 50)
let runnerId: string; // (optional) (default to undefined)

const { status, data } = await apiInstance.adminListRunnerMemoryIncidents(
    from,
    to,
    limit,
    runnerId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **from** | [**Date**] | Inclusive host sample time, with timezone. | |
| **to** | [**Date**] | Exclusive host sample time, after from. | |
| **limit** | [**number**] | Maximum snapshots after per-Box maximum memory selection, ordered by ID ascending. | (optional) defaults to 50|
| **runnerId** | [**string**] |  | (optional) defaults to undefined|


### Return type

**MemoryIncidentListDto**

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

# **adminLookupCiConnections**
> AdminCiConnectionPage adminLookupCiConnections()

Requires account_type and exactly one of github_account or github_account_id. Includes disabled history. No organization membership or Box key scopes are required.

### Example

```typescript
import {
    AdminApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let accountType: 'User' | 'Organization'; //
let cursor: string; //Last binding ID from the previous page. (optional) (default to undefined)
let limit: number; // (optional) (default to 25)
let githubAccount: string; //Exact case-insensitive login; supply this or github_account_id, exclusively. (optional) (default to undefined)
let githubAccountId: string; //Stable GitHub account ID as a decimal string; mutually exclusive with github_account. (optional) (default to undefined)

const { status, data } = await apiInstance.adminLookupCiConnections(
    accountType,
    cursor,
    limit,
    githubAccount,
    githubAccountId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **accountType** | [**&#39;User&#39; &#124; &#39;Organization&#39;**] |  | |
| **cursor** | [**string**] | Last binding ID from the previous page. | (optional) defaults to undefined|
| **limit** | [**number**] |  | (optional) defaults to 25|
| **githubAccount** | [**string**] | Exact case-insensitive login; supply this or github_account_id, exclusively. | (optional) defaults to undefined|
| **githubAccountId** | [**string**] | Stable GitHub account ID as a decimal string; mutually exclusive with github_account. | (optional) defaults to undefined|


### Return type

**AdminCiConnectionPage**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |
|**400** | Invalid request or precondition fields. |  -  |
|**401** | Invalid credentials. |  -  |
|**403** | Current platform administrator authority is required. |  -  |
|**404** | Organization or connection not found. |  -  |
|**409** | Existing, ambiguous or stale mapping; inspect connection or connections when present and repeat lookup. |  -  |

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

# **adminSetOrganizationNestedVirtualization**
> AdminOrganizationNestedVirtualization adminSetOrganizationNestedVirtualization(adminSetOrganizationNestedVirtualizationRequest)


### Example

```typescript
import {
    AdminApi,
    Configuration,
    AdminSetOrganizationNestedVirtualizationRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let organizationId: string; //
let adminSetOrganizationNestedVirtualizationRequest: AdminSetOrganizationNestedVirtualizationRequest; //

const { status, data } = await apiInstance.adminSetOrganizationNestedVirtualization(
    organizationId,
    adminSetOrganizationNestedVirtualizationRequest
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **adminSetOrganizationNestedVirtualizationRequest** | **AdminSetOrganizationNestedVirtualizationRequest**|  | |
| **organizationId** | [**string**] |  | |


### Return type

**AdminOrganizationNestedVirtualization**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **adminUpdateCiConnection**
> AdminCiConnection adminUpdateCiConnection(adminCiConnectionUpdate)


### Example

```typescript
import {
    AdminApi,
    Configuration,
    AdminCiConnectionUpdate
} from './api';

const configuration = new Configuration();
const apiInstance = new AdminApi(configuration);

let organizationId: string; //
let bindingId: string; //
let adminCiConnectionUpdate: AdminCiConnectionUpdate; //

const { status, data } = await apiInstance.adminUpdateCiConnection(
    organizationId,
    bindingId,
    adminCiConnectionUpdate
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **adminCiConnectionUpdate** | **AdminCiConnectionUpdate**|  | |
| **organizationId** | [**string**] |  | |
| **bindingId** | [**string**] |  | |


### Return type

**AdminCiConnection**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Updated connection, including the resulting generation. |  -  |
|**400** | Invalid request or precondition fields. |  -  |
|**401** | Invalid credentials. |  -  |
|**403** | Current platform administrator authority is required. |  -  |
|**404** | Organization or connection not found. |  -  |
|**409** | Existing, ambiguous or stale mapping; inspect connection or connections when present and repeat lookup. |  -  |

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

