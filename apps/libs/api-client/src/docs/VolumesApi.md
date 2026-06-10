# VolumesApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createVolume**](#createvolume) | **POST** /volumes | Create a new volume|
|[**deleteVolume**](#deletevolume) | **DELETE** /volumes/{volumeId} | Delete volume|
|[**getVolume**](#getvolume) | **GET** /volumes/{volumeId} | Get volume details|
|[**getVolumeByName**](#getvolumebyname) | **GET** /volumes/by-name/{name} | Get volume details by name|
|[**listVolumes**](#listvolumes) | **GET** /volumes | List all volumes|

# **createVolume**
> VolumeDto createVolume(createVolume)


### Example

```typescript
import {
    VolumesApi,
    Configuration,
    CreateVolume
} from './api';

const configuration = new Configuration();
const apiInstance = new VolumesApi(configuration);

let createVolume: CreateVolume; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createVolume(
    createVolume,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createVolume** | **CreateVolume**|  | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**VolumeDto**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The volume has been successfully created. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteVolume**
> deleteVolume()


### Example

```typescript
import {
    VolumesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new VolumesApi(configuration);

let volumeId: string; //ID of the volume (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deleteVolume(
    volumeId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **volumeId** | [**string**] | ID of the volume | defaults to undefined|
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
|**200** | Volume has been marked for deletion |  -  |
|**409** | Volume is in use by one or more boxes |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getVolume**
> VolumeDto getVolume()


### Example

```typescript
import {
    VolumesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new VolumesApi(configuration);

let volumeId: string; //ID of the volume (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getVolume(
    volumeId,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **volumeId** | [**string**] | ID of the volume | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**VolumeDto**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Volume details |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getVolumeByName**
> VolumeDto getVolumeByName()


### Example

```typescript
import {
    VolumesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new VolumesApi(configuration);

let name: string; //Name of the volume (default to undefined)
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getVolumeByName(
    name,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **name** | [**string**] | Name of the volume | defaults to undefined|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**VolumeDto**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Volume details |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listVolumes**
> Array<VolumeDto> listVolumes()


### Example

```typescript
import {
    VolumesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new VolumesApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)
let includeDeleted: boolean; //Include deleted volumes in the response (optional) (default to undefined)

const { status, data } = await apiInstance.listVolumes(
    xBoxLiteOrganizationID,
    includeDeleted
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|
| **includeDeleted** | [**boolean**] | Include deleted volumes in the response | (optional) defaults to undefined|


### Return type

**Array<VolumeDto>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | List of all volumes |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

