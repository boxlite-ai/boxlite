# ImagesApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**createImageAlias**](#createimagealias) | **POST** /images/{idOrRef}/aliases | Create an image alias|
|[**deleteImage**](#deleteimage) | **DELETE** /images/{idOrRef} | Remove an image from the catalog|
|[**deleteImageAlias**](#deleteimagealias) | **DELETE** /images/{idOrRef}/aliases/{alias} | Delete an image alias|
|[**getImage**](#getimage) | **GET** /images/{idOrRef} | Get image details|
|[**getImageUsage**](#getimageusage) | **GET** /images/usage | Get image usage|
|[**listImages**](#listimages) | **GET** /images | List images|

# **createImageAlias**
> ImageDetail createImageAlias(createImageAlias)

Creates a catalog alias for a ready version. Existing aliases are refused, including the same binding. The upstream registry and existing boxes are unchanged.

### Example

```typescript
import {
    ImagesApi,
    Configuration,
    CreateImageAlias
} from './api';

const configuration = new Configuration();
const apiInstance = new ImagesApi(configuration);

let idOrRef: string; //Catalog ID or URL-encoded image name
let createImageAlias: CreateImageAlias; //
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.createImageAlias(
    idOrRef,
    createImageAlias,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createImageAlias** | **CreateImageAlias**|  | |
| **idOrRef** | [**string**] | Catalog ID or URL-encoded image name | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ImageDetail**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Image details including the new alias |  -  |
|**400** | Invalid alias, target version or curated image |  -  |
|**404** | No such image in this organization |  -  |
|**409** | The alias already exists |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteImage**
> deleteImage()

Removes the catalog entry, not the bytes: runners keep whatever they cached, and using the same reference again pulls it back as a new entry. A pull never moves a recorded tag, so this is how to pick up where a tag points upstream now; aliases for recorded versions are created and deleted explicitly.

### Example

```typescript
import {
    ImagesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ImagesApi(configuration);

let idOrRef: string; //Catalog ID, or any reference that names the image — URL-encode a reference
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deleteImage(
    idOrRef,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **idOrRef** | [**string**] | Catalog ID, or any reference that names the image — URL-encode a reference | |
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
|**204** | The image is no longer in the catalog |  -  |
|**400** | Curated images belong to the operator and cannot be removed |  -  |
|**404** | No such image in this organization |  -  |
|**409** | Boxes that have not been destroyed can still boot from this image |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **deleteImageAlias**
> deleteImageAlias()

Removes only the catalog binding. Versions, existing boxes and alias history remain.

### Example

```typescript
import {
    ImagesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ImagesApi(configuration);

let idOrRef: string; //Catalog ID or URL-encoded image name
let alias: string; //Catalog alias to delete
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.deleteImageAlias(
    idOrRef,
    alias,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **idOrRef** | [**string**] | Catalog ID or URL-encoded image name | |
| **alias** | [**string**] | Catalog alias to delete | |
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
|**204** | The alias was deleted |  -  |
|**404** | The image or alias does not exist |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getImage**
> ImageDetail getImage()


### Example

```typescript
import {
    ImagesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ImagesApi(configuration);

let idOrRef: string; //Catalog ID, or any reference that names the image — URL-encode a reference, since it contains slashes
let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getImage(
    idOrRef,
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **idOrRef** | [**string**] | Catalog ID, or any reference that names the image — URL-encode a reference, since it contains slashes | |
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ImageDetail**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Image details |  -  |
|**404** | No such image in this organization |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getImageUsage**
> ImageUsage getImageUsage()

How many images this organization holds against its limit, and the total size its pulled versions declared.

### Example

```typescript
import {
    ImagesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ImagesApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.getImageUsage(
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**ImageUsage**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Catalog usage for this organization |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listImages**
> Array<Image> listImages()

The organization’s images together with the operator’s curated set, which every organization shares and none can delete.

### Example

```typescript
import {
    ImagesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ImagesApi(configuration);

let xBoxLiteOrganizationID: string; //Use with JWT to specify the organization ID (optional) (default to undefined)

const { status, data } = await apiInstance.listImages(
    xBoxLiteOrganizationID
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **xBoxLiteOrganizationID** | [**string**] | Use with JWT to specify the organization ID | (optional) defaults to undefined|


### Return type

**Array<Image>**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | The images this organization can boot from |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

