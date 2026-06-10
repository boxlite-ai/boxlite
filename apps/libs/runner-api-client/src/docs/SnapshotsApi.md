# SnapshotsApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**buildSnapshot**](#buildsnapshot) | **POST** /snapshots/build | Build a snapshot|
|[**getBuildLogs**](#getbuildlogs) | **GET** /snapshots/logs | Get build logs|
|[**getSnapshotInfo**](#getsnapshotinfo) | **GET** /snapshots/info | Get snapshot information|
|[**inspectSnapshotInRegistry**](#inspectsnapshotinregistry) | **POST** /snapshots/inspect | Inspect a snapshot in a registry|
|[**pullSnapshot**](#pullsnapshot) | **POST** /snapshots/pull | Pull a snapshot|
|[**removeSnapshot**](#removesnapshot) | **POST** /snapshots/remove | Remove a snapshot|
|[**snapshotExists**](#snapshotexists) | **GET** /snapshots/exists | Check if a snapshot exists|
|[**tagImage**](#tagimage) | **POST** /snapshots/tag | Tag an image|

# **buildSnapshot**
> string buildSnapshot(request)

Build a snapshot from a Dockerfile and context hashes. The operation runs asynchronously and returns 202 immediately.

### Example

```typescript
import {
    SnapshotsApi,
    Configuration,
    BuildSnapshotRequestDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let request: BuildSnapshotRequestDTO; //Build snapshot request

const { status, data } = await apiInstance.buildSnapshot(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **BuildSnapshotRequestDTO**| Build snapshot request | |


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: */*


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**202** | Snapshot build started |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getBuildLogs**
> string getBuildLogs()

Stream build logs

### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let snapshotRef: string; //Snapshot ref (default to undefined)
let follow: boolean; //Whether to follow the log output (optional) (default to undefined)

const { status, data } = await apiInstance.getBuildLogs(
    snapshotRef,
    follow
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **snapshotRef** | [**string**] | Snapshot ref | defaults to undefined|
| **follow** | [**boolean**] | Whether to follow the log output | (optional) defaults to undefined|


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: */*


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Build logs stream |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getSnapshotInfo**
> SnapshotInfoResponse getSnapshotInfo()

Get information about a specified snapshot including size and entrypoint. Returns 422 if the last pull/build operation failed, with the error reason in the message.

### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let snapshot: string; //Snapshot name and tag (default to undefined)

const { status, data } = await apiInstance.getSnapshotInfo(
    snapshot
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **snapshot** | [**string**] | Snapshot name and tag | defaults to undefined|


### Return type

**SnapshotInfoResponse**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**422** | Unprocessable Entity |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **inspectSnapshotInRegistry**
> SnapshotDigestResponse inspectSnapshotInRegistry(request)

Inspect a specified snapshot in a registry

### Example

```typescript
import {
    SnapshotsApi,
    Configuration,
    InspectSnapshotInRegistryRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let request: InspectSnapshotInRegistryRequest; //Inspect snapshot in registry request

const { status, data } = await apiInstance.inspectSnapshotInRegistry(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **InspectSnapshotInRegistryRequest**| Inspect snapshot in registry request | |


### Return type

**SnapshotDigestResponse**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **pullSnapshot**
> string pullSnapshot(request)

Pull a snapshot from a registry and optionally push to another registry. The operation runs asynchronously and returns 202 immediately.

### Example

```typescript
import {
    SnapshotsApi,
    Configuration,
    PullSnapshotRequestDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let request: PullSnapshotRequestDTO; //Pull snapshot

const { status, data } = await apiInstance.pullSnapshot(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **PullSnapshotRequestDTO**| Pull snapshot | |


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: */*


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**202** | Snapshot pull started |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **removeSnapshot**
> string removeSnapshot()

Remove a specified snapshot from the local system

### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let snapshot: string; //Snapshot name and tag (default to undefined)

const { status, data } = await apiInstance.removeSnapshot(
    snapshot
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **snapshot** | [**string**] | Snapshot name and tag | defaults to undefined|


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Snapshot successfully removed |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **snapshotExists**
> SnapshotExistsResponse snapshotExists()

Check if a specified snapshot exists locally

### Example

```typescript
import {
    SnapshotsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let snapshot: string; //Snapshot name and tag (default to undefined)

const { status, data } = await apiInstance.snapshotExists(
    snapshot
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **snapshot** | [**string**] | Snapshot name and tag | defaults to undefined|


### Return type

**SnapshotExistsResponse**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **tagImage**
> string tagImage(request)

Tag an existing local image with a new target reference

### Example

```typescript
import {
    SnapshotsApi,
    Configuration,
    TagImageRequestDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new SnapshotsApi(configuration);

let request: TagImageRequestDTO; //Tag image request

const { status, data } = await apiInstance.tagImage(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **TagImageRequestDTO**| Tag image request | |


### Return type

**string**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: */*


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Image successfully tagged |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**404** | Not Found |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

