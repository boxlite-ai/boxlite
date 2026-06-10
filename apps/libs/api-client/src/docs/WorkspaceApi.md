# WorkspaceApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createWorkspaceDeprecated**](#createworkspacedeprecated) | **POST** /workspace | [DEPRECATED] Create a new workspace|
|[**deleteWorkspaceDeprecated**](#deleteworkspacedeprecated) | **DELETE** /workspace/{workspaceId} | [DEPRECATED] Delete workspace|
|[**getPortPreviewUrlWorkspaceDeprecated**](#getportpreviewurlworkspacedeprecated) | **GET** /workspace/{workspaceId}/ports/{port}/preview-url | [DEPRECATED] Get preview URL for a workspace port|
|[**getWorkspaceDeprecated**](#getworkspacedeprecated) | **GET** /workspace/{workspaceId} | [DEPRECATED] Get workspace details|
|[**listWorkspacesDeprecated**](#listworkspacesdeprecated) | **GET** /workspace | [DEPRECATED] List all workspaces|
|[**replaceLabelsWorkspaceDeprecated**](#replacelabelsworkspacedeprecated) | **PUT** /workspace/{workspaceId}/labels | [DEPRECATED] Replace workspace labels|
|[**setAutostopIntervalWorkspaceDeprecated**](#setautostopintervalworkspacedeprecated) | **POST** /workspace/{workspaceId}/autostop/{interval} | [DEPRECATED] Set workspace auto-stop interval|
|[**startWorkspaceDeprecated**](#startworkspacedeprecated) | **POST** /workspace/{workspaceId}/start | [DEPRECATED] Start workspace|
|[**stopWorkspaceDeprecated**](#stopworkspacedeprecated) | **POST** /workspace/{workspaceId}/stop | [DEPRECATED] Stop workspace|
|[**updatePublicStatusWorkspaceDeprecated**](#updatepublicstatusworkspacedeprecated) | **POST** /workspace/{workspaceId}/public/{isPublic} | [DEPRECATED] Update public status|

# **createWorkspaceDeprecated**
> Workspace createWorkspaceDeprecated(createWorkspace)


### Example

```typescript
import {
    WorkspaceApi,
    Configuration,
    CreateWorkspace
} from './api';

const configuration = new Configuration();
const apiInstance = new WorkspaceApi(configuration);

let createWorkspace: CreateWorkspace; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createWorkspaceDeprecated(
    createWorkspace,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createWorkspace** | **CreateWorkspace**|  | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Workspace**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The workspace has been successfully created. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteWorkspaceDeprecated**
> deleteWorkspaceDeprecated()


### Example

```typescript
import {
    WorkspaceApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new WorkspaceApi(configuration);

let workspaceId: string; //ID of the workspace (default to undefined)
let force: boolean; // (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deleteWorkspaceDeprecated(
    workspaceId,
    force,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **workspaceId** | [**string**] | ID of the workspace | defaults to undefined|
| **force** | [**boolean**] |  | defaults to undefined|
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
|**200** | Workspace has been deleted |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getPortPreviewUrlWorkspaceDeprecated**
> WorkspacePortPreviewUrl getPortPreviewUrlWorkspaceDeprecated()


### Example

```typescript
import {
    WorkspaceApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new WorkspaceApi(configuration);

let workspaceId: string; //ID of the workspace (default to undefined)
let port: number; //Port number to get preview URL for (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getPortPreviewUrlWorkspaceDeprecated(
    workspaceId,
    port,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **workspaceId** | [**string**] | ID of the workspace | defaults to undefined|
| **port** | [**number**] | Port number to get preview URL for | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**WorkspacePortPreviewUrl**

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

# **getWorkspaceDeprecated**
> Workspace getWorkspaceDeprecated()


### Example

```typescript
import {
    WorkspaceApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new WorkspaceApi(configuration);

let workspaceId: string; //ID of the workspace (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let verbose: boolean; //Include verbose output (optional) (default to undefined)

const { status, data } = await apiInstance.getWorkspaceDeprecated(
    workspaceId,
    xBoxLiteOrganizationID,
    verbose
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **workspaceId** | [**string**] | ID of the workspace | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **verbose** | [**boolean**] | Include verbose output | (optional) defaults to undefined|


### Return type

**Workspace**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Workspace details |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listWorkspacesDeprecated**
> Array<Workspace> listWorkspacesDeprecated()


### Example

```typescript
import {
    WorkspaceApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new WorkspaceApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let verbose: boolean; //Include verbose output (optional) (default to undefined)
let labels: string; //JSON encoded labels to filter by (optional) (default to undefined)

const { status, data } = await apiInstance.listWorkspacesDeprecated(
    xBoxLiteOrganizationID,
    verbose,
    labels
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **verbose** | [**boolean**] | Include verbose output | (optional) defaults to undefined|
| **labels** | [**string**] | JSON encoded labels to filter by | (optional) defaults to undefined|


### Return type

**Array<Workspace>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of all workspacees |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **replaceLabelsWorkspaceDeprecated**
> BoxLabels replaceLabelsWorkspaceDeprecated(boxLabels)


### Example

```typescript
import {
    WorkspaceApi,
    Configuration,
    BoxLabels
} from './api';

const configuration = new Configuration();
const apiInstance = new WorkspaceApi(configuration);

let workspaceId: string; //ID of the workspace (default to undefined)
let boxLabels: BoxLabels; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.replaceLabelsWorkspaceDeprecated(
    workspaceId,
    boxLabels,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **boxLabels** | **BoxLabels**|  | |
| **workspaceId** | [**string**] | ID of the workspace | defaults to undefined|
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

# **setAutostopIntervalWorkspaceDeprecated**
> setAutostopIntervalWorkspaceDeprecated()


### Example

```typescript
import {
    WorkspaceApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new WorkspaceApi(configuration);

let workspaceId: string; //ID of the workspace (default to undefined)
let interval: number; //Auto-stop interval in minutes (0 to disable) (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.setAutostopIntervalWorkspaceDeprecated(
    workspaceId,
    interval,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **workspaceId** | [**string**] | ID of the workspace | defaults to undefined|
| **interval** | [**number**] | Auto-stop interval in minutes (0 to disable) | defaults to undefined|
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
|**200** | Auto-stop interval has been set |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **startWorkspaceDeprecated**
> startWorkspaceDeprecated()


### Example

```typescript
import {
    WorkspaceApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new WorkspaceApi(configuration);

let workspaceId: string; //ID of the workspace (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.startWorkspaceDeprecated(
    workspaceId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **workspaceId** | [**string**] | ID of the workspace | defaults to undefined|
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
|**200** | Workspace has been started |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **stopWorkspaceDeprecated**
> stopWorkspaceDeprecated()


### Example

```typescript
import {
    WorkspaceApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new WorkspaceApi(configuration);

let workspaceId: string; //ID of the workspace (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.stopWorkspaceDeprecated(
    workspaceId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **workspaceId** | [**string**] | ID of the workspace | defaults to undefined|
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
|**200** | Workspace has been stopped |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **updatePublicStatusWorkspaceDeprecated**
> updatePublicStatusWorkspaceDeprecated()


### Example

```typescript
import {
    WorkspaceApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new WorkspaceApi(configuration);

let workspaceId: string; //ID of the workspace (default to undefined)
let isPublic: boolean; //Public status to set (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.updatePublicStatusWorkspaceDeprecated(
    workspaceId,
    isPublic,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **workspaceId** | [**string**] | ID of the workspace | defaults to undefined|
| **isPublic** | [**boolean**] | Public status to set | defaults to undefined|
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
|**201** |  |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

