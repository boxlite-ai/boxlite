# LspApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**completions**](#completions) | **POST** /lsp/completions | Get code completions|
|[**didClose**](#didclose) | **POST** /lsp/did-close | Notify document closed|
|[**didOpen**](#didopen) | **POST** /lsp/did-open | Notify document opened|
|[**documentSymbols**](#documentsymbols) | **GET** /lsp/document-symbols | Get document symbols|
|[**start**](#start) | **POST** /lsp/start | Start LSP server|
|[**stop**](#stop) | **POST** /lsp/stop | Stop LSP server|
|[**workspaceSymbols**](#workspacesymbols) | **GET** /lsp/workspacesymbols | Get workspace symbols|

# **completions**
> CompletionList completions(request)

Get code completion suggestions from the LSP server

### Example

```typescript
import {
    LspApi,
    Configuration,
    LspCompletionParams
} from './api';

const configuration = new Configuration();
const apiInstance = new LspApi(configuration);

let request: LspCompletionParams; //Completion request

const { status, data } = await apiInstance.completions(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **LspCompletionParams**| Completion request | |


### Return type

**CompletionList**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **didClose**
> didClose(request)

Notify the LSP server that a document has been closed

### Example

```typescript
import {
    LspApi,
    Configuration,
    LspDocumentRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new LspApi(configuration);

let request: LspDocumentRequest; //Document request

const { status, data } = await apiInstance.didClose(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **LspDocumentRequest**| Document request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **didOpen**
> didOpen(request)

Notify the LSP server that a document has been opened

### Example

```typescript
import {
    LspApi,
    Configuration,
    LspDocumentRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new LspApi(configuration);

let request: LspDocumentRequest; //Document request

const { status, data } = await apiInstance.didOpen(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **LspDocumentRequest**| Document request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **documentSymbols**
> Array<LspSymbol> documentSymbols()

Get symbols (functions, classes, etc.) from a document

### Example

```typescript
import {
    LspApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LspApi(configuration);

let languageId: string; //Language ID (e.g., python, typescript) (default to undefined)
let pathToProject: string; //Path to project (default to undefined)
let uri: string; //Document URI (default to undefined)

const { status, data } = await apiInstance.documentSymbols(
    languageId,
    pathToProject,
    uri
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **languageId** | [**string**] | Language ID (e.g., python, typescript) | defaults to undefined|
| **pathToProject** | [**string**] | Path to project | defaults to undefined|
| **uri** | [**string**] | Document URI | defaults to undefined|


### Return type

**Array<LspSymbol>**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **start**
> start(request)

Start a Language Server Protocol server for the specified language

### Example

```typescript
import {
    LspApi,
    Configuration,
    LspServerRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new LspApi(configuration);

let request: LspServerRequest; //LSP server request

const { status, data } = await apiInstance.start(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **LspServerRequest**| LSP server request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **stop**
> stop(request)

Stop a Language Server Protocol server

### Example

```typescript
import {
    LspApi,
    Configuration,
    LspServerRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new LspApi(configuration);

let request: LspServerRequest; //LSP server request

const { status, data } = await apiInstance.stop(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **LspServerRequest**| LSP server request | |


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **workspaceSymbols**
> Array<LspSymbol> workspaceSymbols()

Search for symbols across the entire workspace

### Example

```typescript
import {
    LspApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LspApi(configuration);

let query: string; //Search query (default to undefined)
let languageId: string; //Language ID (e.g., python, typescript) (default to undefined)
let pathToProject: string; //Path to project (default to undefined)

const { status, data } = await apiInstance.workspaceSymbols(
    query,
    languageId,
    pathToProject
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **query** | [**string**] | Search query | defaults to undefined|
| **languageId** | [**string**] | Language ID (e.g., python, typescript) | defaults to undefined|
| **pathToProject** | [**string**] | Path to project | defaults to undefined|


### Return type

**Array<LspSymbol>**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

