# RunnersApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createRunner**](#createrunner) | **POST** /runners | Create runner|
|[**deleteRunner**](#deleterunner) | **DELETE** /runners/{id} | Delete runner|
|[**getInfoForAuthenticatedRunner**](#getinfoforauthenticatedrunner) | **GET** /runners/me | Get info for authenticated runner|
|[**getRunnerByBoxId**](#getrunnerbyboxid) | **GET** /runners/by-box/{boxId} | Get runner by box ID|
|[**getRunnerById**](#getrunnerbyid) | **GET** /runners/{id} | Get runner by ID|
|[**getRunnerFullById**](#getrunnerfullbyid) | **GET** /runners/{id}/full | Get runner by ID|
|[**getRunnersBySnapshotRef**](#getrunnersbysnapshotref) | **GET** /runners/by-snapshot-ref | Get runners by snapshot ref|
|[**listRunners**](#listrunners) | **GET** /runners | List all runners|
|[**runnerHealthcheck**](#runnerhealthcheck) | **POST** /runners/healthcheck | Runner healthcheck|
|[**updateRunnerDraining**](#updaterunnerdraining) | **PATCH** /runners/{id}/draining | Update runner draining status|
|[**updateRunnerScheduling**](#updaterunnerscheduling) | **PATCH** /runners/{id}/scheduling | Update runner scheduling status|

# **createRunner**
> CreateRunnerResponse createRunner(createRunner)


### Example

```typescript
import {
    RunnersApi,
    Configuration,
    CreateRunner
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

let createRunner: CreateRunner; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createRunner(
    createRunner,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createRunner** | **CreateRunner**|  | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


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

# **deleteRunner**
> deleteRunner()


### Example

```typescript
import {
    RunnersApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

let id: string; //Runner ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deleteRunner(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Runner ID | defaults to undefined|
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
|**204** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getInfoForAuthenticatedRunner**
> RunnerFull getInfoForAuthenticatedRunner()


### Example

```typescript
import {
    RunnersApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

const { status, data } = await apiInstance.getInfoForAuthenticatedRunner();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**RunnerFull**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Runner info |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getRunnerByBoxId**
> RunnerFull getRunnerByBoxId()


### Example

```typescript
import {
    RunnersApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

let boxId: string; // (default to undefined)

const { status, data } = await apiInstance.getRunnerByBoxId(
    boxId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxId** | [**string**] |  | defaults to undefined|


### Return type

**RunnerFull**

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

# **getRunnerById**
> Runner getRunnerById()


### Example

```typescript
import {
    RunnersApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

let id: string; //Runner ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getRunnerById(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Runner ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Runner**

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

# **getRunnerFullById**
> RunnerFull getRunnerFullById()


### Example

```typescript
import {
    RunnersApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

let id: string; //Runner ID (default to undefined)

const { status, data } = await apiInstance.getRunnerFullById(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Runner ID | defaults to undefined|


### Return type

**RunnerFull**

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

# **getRunnersBySnapshotRef**
> Array<RunnerSnapshotDto> getRunnersBySnapshotRef()


### Example

```typescript
import {
    RunnersApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

let ref: string; //Snapshot ref (default to undefined)

const { status, data } = await apiInstance.getRunnersBySnapshotRef(
    ref
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **ref** | [**string**] | Snapshot ref | defaults to undefined|


### Return type

**Array<RunnerSnapshotDto>**

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

# **listRunners**
> Array<Runner> listRunners()


### Example

```typescript
import {
    RunnersApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.listRunners(
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<Runner>**

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

# **runnerHealthcheck**
> runnerHealthcheck(runnerHealthcheck)

Endpoint for version 2 runners to send healthcheck and metrics. Updates lastChecked timestamp and runner metrics.

### Example

```typescript
import {
    RunnersApi,
    Configuration,
    RunnerHealthcheck
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

let runnerHealthcheck: RunnerHealthcheck; //

const { status, data } = await apiInstance.runnerHealthcheck(
    runnerHealthcheck
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **runnerHealthcheck** | **RunnerHealthcheck**|  | |


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
|**200** | Healthcheck received |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updateRunnerDraining**
> Runner updateRunnerDraining()


### Example

```typescript
import {
    RunnersApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

let id: string; //Runner ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.updateRunnerDraining(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Runner ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Runner**

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

# **updateRunnerScheduling**
> Runner updateRunnerScheduling()


### Example

```typescript
import {
    RunnersApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new RunnersApi(configuration);

let id: string; //Runner ID (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.updateRunnerScheduling(
    id,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Runner ID | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Runner**

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

