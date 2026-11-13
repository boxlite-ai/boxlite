# BoxApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createAttachTicket**](#createattachticket) | **POST** /box/{boxIdOrName}/attach-tickets | Get a one-time ticket for the attach WebSocket|
|[**getBox**](#getbox) | **GET** /box/{boxIdOrName} | Get box details|
|[**getBoxesForRunner**](#getboxesforrunner) | **GET** /box/for-runner | Get boxes for the authenticated runner|
|[**listBoxesPaginated**](#listboxespaginated) | **GET** /box/paginated | List all boxes paginated|
|[**recoverBox**](#recoverbox) | **POST** /box/{boxIdOrName}/recover | Recover box from error state|
|[**updateBoxState**](#updateboxstate) | **PUT** /box/{boxId}/state | Update box state|
|[**updateLastActivity**](#updatelastactivity) | **POST** /box/{boxId}/last-activity | Update box last activity|

# **createAttachTicket**
> AttachTicket createAttachTicket(createAttachTicket)


### Example

```typescript
import {
    BoxApi,
    Configuration,
    CreateAttachTicket
} from './api';

const configuration = new Configuration();
const apiInstance = new BoxApi(configuration);

let boxIdOrName: string; //ID or name of the box
let createAttachTicket: CreateAttachTicket; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createAttachTicket(
    boxIdOrName,
    createAttachTicket,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createAttachTicket** | **CreateAttachTicket**|  | |
| **boxIdOrName** | [**string**] | ID or name of the box | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**AttachTicket**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | A single-use ticket for one attach upgrade to the execution |  -  |

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

