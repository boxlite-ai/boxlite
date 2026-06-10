# SnapshotsApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**activateSnapshot**](#activatesnapshot) | **POST** /snapshots/{id}/activate | Activate a snapshot|
|[**canCleanupImage**](#cancleanupimage) | **GET** /snapshots/can-cleanup-image | Check if an image can be cleaned up|
|[**createSnapshot**](#createsnapshot) | **POST** /snapshots | Create a new snapshot|
|[**deactivateSnapshot**](#deactivatesnapshot) | **POST** /snapshots/{id}/deactivate | Deactivate a snapshot|
|[**getAllSnapshots**](#getallsnapshots) | **GET** /snapshots | List all snapshots|
|[**getSnapshot**](#getsnapshot) | **GET** /snapshots/{id} | Get snapshot by ID or name|
|[**getSnapshotBuildLogs**](#getsnapshotbuildlogs) | **GET** /snapshots/{id}/build-logs | Get snapshot build logs|
|[**getSnapshotBuildLogsUrl**](#getsnapshotbuildlogsurl) | **GET** /snapshots/{id}/build-logs-url | Get snapshot build logs URL|
|[**removeSnapshot**](#removesnapshot) | **DELETE** /snapshots/{id} | Delete snapshot|
|[**setSnapshotGeneralStatus**](#setsnapshotgeneralstatus) | **PATCH** /snapshots/{id}/general | Set snapshot general status|

# **activateSnapshot**
> SnapshotDto activateSnapshot()


### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let id: string; //Snapshot ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.activateSnapshot(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Snapshot ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**SnapshotDto**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The snapshot has been successfully activated. |  -  |
|**400** | Bad request - Snapshot is already active, not in inactive state, or has associated snapshot runners |  -  |
|**404** | Snapshot not found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **canCleanupImage**
> boolean canCleanupImage()


### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let imageName: string; //Image name with tag to check (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.canCleanupImage(
    imageName,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **imageName** | [**string**] | Image name with tag to check | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**boolean**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Boolean indicating if image can be cleaned up |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createSnapshot**
> SnapshotDto createSnapshot(createSnapshot)


### Example

```typescript
import {
    SnapshotsApi,
    Configuration,
    CreateSnapshot
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let createSnapshot: CreateSnapshot; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createSnapshot(
    createSnapshot,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createSnapshot** | **CreateSnapshot**|  | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**SnapshotDto**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The snapshot has been successfully created. |  -  |
|**400** | Bad request - Snapshots with tag \&quot;:latest\&quot; are not allowed |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deactivateSnapshot**
> deactivateSnapshot()


### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let id: string; //Snapshot ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deactivateSnapshot(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Snapshot ID | defaults to undefined|
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
|**204** | The snapshot has been successfully deactivated. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getAllSnapshots**
> PaginatedSnapshots getAllSnapshots()


### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let page: number; //Page number of the results (optional) (default to 1)
let limit: number; //Number of results per page (optional) (default to 100)
let name: string; //Filter by partial name match (optional) (default to undefined)
let sort: 'name' | 'state' | 'lastUsedAt' | 'createdAt'; //Field to sort by (optional) (default to 'lastUsedAt')
let order: 'asc' | 'desc'; //Direction to sort by (optional) (default to 'desc')

const { status, data } = await apiInstance.getAllSnapshots(
    xBoxLiteOrganizationID,
    page,
    limit,
    name,
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
| **name** | [**string**] | Filter by partial name match | (optional) defaults to undefined|
| **sort** | [**&#39;name&#39; | &#39;state&#39; | &#39;lastUsedAt&#39; | &#39;createdAt&#39;**]**Array<&#39;name&#39; &#124; &#39;state&#39; &#124; &#39;lastUsedAt&#39; &#124; &#39;createdAt&#39; &#124; &#39;11184809&#39;>** | Field to sort by | (optional) defaults to 'lastUsedAt'|
| **order** | [**&#39;asc&#39; | &#39;desc&#39;**]**Array<&#39;asc&#39; &#124; &#39;desc&#39; &#124; &#39;11184809&#39;>** | Direction to sort by | (optional) defaults to 'desc'|


### Return type

**PaginatedSnapshots**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Paginated list of all snapshots |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getSnapshot**
> SnapshotDto getSnapshot()


### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let id: string; //Snapshot ID or name (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getSnapshot(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Snapshot ID or name | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**SnapshotDto**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The snapshot |  -  |
|**404** | Snapshot not found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getSnapshotBuildLogs**
> getSnapshotBuildLogs()

This endpoint is deprecated. Use `getSnapshotBuildLogsUrl` instead.

### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let id: string; //Snapshot ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let follow: boolean; //Whether to follow the logs stream (optional) (default to undefined)

const { status, data } = await apiInstance.getSnapshotBuildLogs(
    id,
    xBoxLiteOrganizationID,
    follow
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Snapshot ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **follow** | [**boolean**] | Whether to follow the logs stream | (optional) defaults to undefined|


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

# **getSnapshotBuildLogsUrl**
> Url getSnapshotBuildLogsUrl()


### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let id: string; //Snapshot ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getSnapshotBuildLogsUrl(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Snapshot ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Url**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The snapshot build logs URL |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **removeSnapshot**
> removeSnapshot()


### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let id: string; //Snapshot ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.removeSnapshot(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Snapshot ID | defaults to undefined|
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
|**200** | Snapshot has been deleted |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **setSnapshotGeneralStatus**
> SnapshotDto setSnapshotGeneralStatus(setSnapshotGeneralStatusDto)


### Example

```typescript
import {
    SnapshotsApi,
    Configuration,
    SetSnapshotGeneralStatusDto
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let id: string; //Snapshot ID (default to undefined)
let setSnapshotGeneralStatusDto: SetSnapshotGeneralStatusDto; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.setSnapshotGeneralStatus(
    id,
    setSnapshotGeneralStatusDto,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **setSnapshotGeneralStatusDto** | **SetSnapshotGeneralStatusDto**|  | |
| **id** | [**string**] | Snapshot ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**SnapshotDto**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Snapshot general status has been set |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

