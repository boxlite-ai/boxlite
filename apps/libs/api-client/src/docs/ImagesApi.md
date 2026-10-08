# ImagesApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**deleteImage**](#deleteimage) | **DELETE** /images/{idOrRef} | Remove an image from the catalog|
|[**getImage**](#getimage) | **GET** /images/{idOrRef} | Get image details|
|[**getImageUsage**](#getimageusage) | **GET** /images/usage | Get image usage|
|[**listImages**](#listimages) | **GET** /images | List images|

# **deleteImage**
> deleteImage()

Removes the catalog entry, not the bytes: runners keep whatever they cached, and using the same reference again pulls it back as a new entry. That is also how to pick up a tag that has moved upstream, since a recorded tag keeps the digest it first resolved to.

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

