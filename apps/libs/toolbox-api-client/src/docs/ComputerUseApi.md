# ComputerUseApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**click**](#click) | **POST** /computeruse/mouse/click | Click mouse button|
|[**deleteRecording**](#deleterecording) | **DELETE** /computeruse/recordings/{id} | Delete a recording|
|[**downloadRecording**](#downloadrecording) | **GET** /computeruse/recordings/{id}/download | Download a recording|
|[**drag**](#drag) | **POST** /computeruse/mouse/drag | Drag mouse|
|[**getComputerUseStatus**](#getcomputerusestatus) | **GET** /computeruse/process-status | Get computer use process status|
|[**getComputerUseSystemStatus**](#getcomputerusesystemstatus) | **GET** /computeruse/status | Get computer use status|
|[**getDisplayInfo**](#getdisplayinfo) | **GET** /computeruse/display/info | Get display information|
|[**getMousePosition**](#getmouseposition) | **GET** /computeruse/mouse/position | Get mouse position|
|[**getProcessErrors**](#getprocesserrors) | **GET** /computeruse/process/{processName}/errors | Get process errors|
|[**getProcessLogs**](#getprocesslogs) | **GET** /computeruse/process/{processName}/logs | Get process logs|
|[**getProcessStatus**](#getprocessstatus) | **GET** /computeruse/process/{processName}/status | Get specific process status|
|[**getRecording**](#getrecording) | **GET** /computeruse/recordings/{id} | Get recording details|
|[**getWindows**](#getwindows) | **GET** /computeruse/display/windows | Get windows information|
|[**listRecordings**](#listrecordings) | **GET** /computeruse/recordings | List all recordings|
|[**moveMouse**](#movemouse) | **POST** /computeruse/mouse/move | Move mouse cursor|
|[**pressHotkey**](#presshotkey) | **POST** /computeruse/keyboard/hotkey | Press hotkey|
|[**pressKey**](#presskey) | **POST** /computeruse/keyboard/key | Press key|
|[**restartProcess**](#restartprocess) | **POST** /computeruse/process/{processName}/restart | Restart specific process|
|[**scroll**](#scroll) | **POST** /computeruse/mouse/scroll | Scroll mouse wheel|
|[**startComputerUse**](#startcomputeruse) | **POST** /computeruse/start | Start computer use processes|
|[**startRecording**](#startrecording) | **POST** /computeruse/recordings/start | Start a new recording|
|[**stopComputerUse**](#stopcomputeruse) | **POST** /computeruse/stop | Stop computer use processes|
|[**stopRecording**](#stoprecording) | **POST** /computeruse/recordings/stop | Stop a recording|
|[**takeCompressedRegionScreenshot**](#takecompressedregionscreenshot) | **GET** /computeruse/screenshot/region/compressed | Take a compressed region screenshot|
|[**takeCompressedScreenshot**](#takecompressedscreenshot) | **GET** /computeruse/screenshot/compressed | Take a compressed screenshot|
|[**takeRegionScreenshot**](#takeregionscreenshot) | **GET** /computeruse/screenshot/region | Take a region screenshot|
|[**takeScreenshot**](#takescreenshot) | **GET** /computeruse/screenshot | Take a screenshot|
|[**typeText**](#typetext) | **POST** /computeruse/keyboard/type | Type text|

# **click**
> MouseClickResponse click(request)

Click the mouse button at the specified coordinates

### Example

```typescript
import {
    ComputerUseApi,
    Configuration,
    MouseClickRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let request: MouseClickRequest; //Mouse click request

const { status, data } = await apiInstance.click(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **MouseClickRequest**| Mouse click request | |


### Return type

**MouseClickResponse**

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

# **deleteRecording**
> deleteRecording()

Delete a recording file by ID

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let id: string; //Recording ID (default to undefined)

const { status, data } = await apiInstance.deleteRecording(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Recording ID | defaults to undefined|


### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: */*


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**204** | No Content |  -  |
|**400** | Bad Request |  -  |
|**404** | Not Found |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **downloadRecording**
> File downloadRecording()

Download a recording by providing its ID

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let id: string; //Recording ID (default to undefined)

const { status, data } = await apiInstance.downloadRecording(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Recording ID | defaults to undefined|


### Return type

**File**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/octet-stream


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**404** | Not Found |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **drag**
> MouseDragResponse drag(request)

Drag the mouse from start to end coordinates

### Example

```typescript
import {
    ComputerUseApi,
    Configuration,
    MouseDragRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let request: MouseDragRequest; //Mouse drag request

const { status, data } = await apiInstance.drag(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **MouseDragRequest**| Mouse drag request | |


### Return type

**MouseDragResponse**

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

# **getComputerUseStatus**
> ComputerUseStatusResponse getComputerUseStatus()

Get the status of all computer use processes

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

const { status, data } = await apiInstance.getComputerUseStatus();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**ComputerUseStatusResponse**

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

# **getComputerUseSystemStatus**
> ComputerUseStatusResponse getComputerUseSystemStatus()

Get the current status of the computer use system

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

const { status, data } = await apiInstance.getComputerUseSystemStatus();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**ComputerUseStatusResponse**

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

# **getDisplayInfo**
> DisplayInfoResponse getDisplayInfo()

Get information about all available displays

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

const { status, data } = await apiInstance.getDisplayInfo();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**DisplayInfoResponse**

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

# **getMousePosition**
> MousePositionResponse getMousePosition()

Get the current mouse cursor position

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

const { status, data } = await apiInstance.getMousePosition();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**MousePositionResponse**

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

# **getProcessErrors**
> ProcessErrorsResponse getProcessErrors()

Get errors for a specific computer use process

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let processName: string; //Process name to get errors for (default to undefined)

const { status, data } = await apiInstance.getProcessErrors(
    processName
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **processName** | [**string**] | Process name to get errors for | defaults to undefined|


### Return type

**ProcessErrorsResponse**

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

# **getProcessLogs**
> ProcessLogsResponse getProcessLogs()

Get logs for a specific computer use process

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let processName: string; //Process name to get logs for (default to undefined)

const { status, data } = await apiInstance.getProcessLogs(
    processName
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **processName** | [**string**] | Process name to get logs for | defaults to undefined|


### Return type

**ProcessLogsResponse**

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

# **getProcessStatus**
> ProcessStatusResponse getProcessStatus()

Check if a specific computer use process is running

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let processName: string; //Process name to check (default to undefined)

const { status, data } = await apiInstance.getProcessStatus(
    processName
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **processName** | [**string**] | Process name to check | defaults to undefined|


### Return type

**ProcessStatusResponse**

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

# **getRecording**
> Recording getRecording()

Get details of a specific recording by ID

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let id: string; //Recording ID (default to undefined)

const { status, data } = await apiInstance.getRecording(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] | Recording ID | defaults to undefined|


### Return type

**Recording**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**404** | Not Found |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getWindows**
> WindowsResponse getWindows()

Get information about all open windows

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

const { status, data } = await apiInstance.getWindows();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**WindowsResponse**

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

# **listRecordings**
> ListRecordingsResponse listRecordings()

Get a list of all recordings (active and completed)

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

const { status, data } = await apiInstance.listRecordings();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**ListRecordingsResponse**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **moveMouse**
> MousePositionResponse moveMouse(request)

Move the mouse cursor to the specified coordinates

### Example

```typescript
import {
    ComputerUseApi,
    Configuration,
    MouseMoveRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let request: MouseMoveRequest; //Mouse move request

const { status, data } = await apiInstance.moveMouse(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **MouseMoveRequest**| Mouse move request | |


### Return type

**MousePositionResponse**

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

# **pressHotkey**
> object pressHotkey(request)

Press a hotkey combination (e.g., ctrl+c, cmd+v)

### Example

```typescript
import {
    ComputerUseApi,
    Configuration,
    KeyboardHotkeyRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let request: KeyboardHotkeyRequest; //Hotkey press request

const { status, data } = await apiInstance.pressHotkey(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **KeyboardHotkeyRequest**| Hotkey press request | |


### Return type

**object**

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

# **pressKey**
> object pressKey(request)

Press a key with optional modifiers

### Example

```typescript
import {
    ComputerUseApi,
    Configuration,
    KeyboardPressRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let request: KeyboardPressRequest; //Key press request

const { status, data } = await apiInstance.pressKey(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **KeyboardPressRequest**| Key press request | |


### Return type

**object**

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

# **restartProcess**
> ProcessRestartResponse restartProcess()

Restart a specific computer use process

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let processName: string; //Process name to restart (default to undefined)

const { status, data } = await apiInstance.restartProcess(
    processName
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **processName** | [**string**] | Process name to restart | defaults to undefined|


### Return type

**ProcessRestartResponse**

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

# **scroll**
> ScrollResponse scroll(request)

Scroll the mouse wheel at the specified coordinates

### Example

```typescript
import {
    ComputerUseApi,
    Configuration,
    MouseScrollRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let request: MouseScrollRequest; //Mouse scroll request

const { status, data } = await apiInstance.scroll(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **MouseScrollRequest**| Mouse scroll request | |


### Return type

**ScrollResponse**

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

# **startComputerUse**
> ComputerUseStartResponse startComputerUse()

Start all computer use processes and return their status

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

const { status, data } = await apiInstance.startComputerUse();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**ComputerUseStartResponse**

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

# **startRecording**
> Recording startRecording()

Start a new screen recording session

### Example

```typescript
import {
    ComputerUseApi,
    Configuration,
    StartRecordingRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let request: StartRecordingRequest; //Recording options (optional)

const { status, data } = await apiInstance.startRecording(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **StartRecordingRequest**| Recording options | |


### Return type

**Recording**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Created |  -  |
|**400** | Bad Request |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **stopComputerUse**
> ComputerUseStopResponse stopComputerUse()

Stop all computer use processes and return their status

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

const { status, data } = await apiInstance.stopComputerUse();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**ComputerUseStopResponse**

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

# **stopRecording**
> Recording stopRecording(request)

Stop an active screen recording session

### Example

```typescript
import {
    ComputerUseApi,
    Configuration,
    StopRecordingRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let request: StopRecordingRequest; //Recording ID to stop

const { status, data } = await apiInstance.stopRecording(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **StopRecordingRequest**| Recording ID to stop | |


### Return type

**Recording**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**400** | Bad Request |  -  |
|**404** | Not Found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **takeCompressedRegionScreenshot**
> ScreenshotResponse takeCompressedRegionScreenshot()

Take a compressed screenshot of a specific region of the screen

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let x: number; //X coordinate of the region (default to undefined)
let y: number; //Y coordinate of the region (default to undefined)
let width: number; //Width of the region (default to undefined)
let height: number; //Height of the region (default to undefined)
let showCursor: boolean; //Whether to show cursor in screenshot (optional) (default to undefined)
let format: string; //Image format (png or jpeg) (optional) (default to undefined)
let quality: number; //JPEG quality (1-100) (optional) (default to undefined)
let scale: number; //Scale factor (0.1-1.0) (optional) (default to undefined)

const { status, data } = await apiInstance.takeCompressedRegionScreenshot(
    x,
    y,
    width,
    height,
    showCursor,
    format,
    quality,
    scale
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **x** | [**number**] | X coordinate of the region | defaults to undefined|
| **y** | [**number**] | Y coordinate of the region | defaults to undefined|
| **width** | [**number**] | Width of the region | defaults to undefined|
| **height** | [**number**] | Height of the region | defaults to undefined|
| **showCursor** | [**boolean**] | Whether to show cursor in screenshot | (optional) defaults to undefined|
| **format** | [**string**] | Image format (png or jpeg) | (optional) defaults to undefined|
| **quality** | [**number**] | JPEG quality (1-100) | (optional) defaults to undefined|
| **scale** | [**number**] | Scale factor (0.1-1.0) | (optional) defaults to undefined|


### Return type

**ScreenshotResponse**

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

# **takeCompressedScreenshot**
> ScreenshotResponse takeCompressedScreenshot()

Take a compressed screenshot of the entire screen

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let showCursor: boolean; //Whether to show cursor in screenshot (optional) (default to undefined)
let format: string; //Image format (png or jpeg) (optional) (default to undefined)
let quality: number; //JPEG quality (1-100) (optional) (default to undefined)
let scale: number; //Scale factor (0.1-1.0) (optional) (default to undefined)

const { status, data } = await apiInstance.takeCompressedScreenshot(
    showCursor,
    format,
    quality,
    scale
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **showCursor** | [**boolean**] | Whether to show cursor in screenshot | (optional) defaults to undefined|
| **format** | [**string**] | Image format (png or jpeg) | (optional) defaults to undefined|
| **quality** | [**number**] | JPEG quality (1-100) | (optional) defaults to undefined|
| **scale** | [**number**] | Scale factor (0.1-1.0) | (optional) defaults to undefined|


### Return type

**ScreenshotResponse**

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

# **takeRegionScreenshot**
> ScreenshotResponse takeRegionScreenshot()

Take a screenshot of a specific region of the screen

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let x: number; //X coordinate of the region (default to undefined)
let y: number; //Y coordinate of the region (default to undefined)
let width: number; //Width of the region (default to undefined)
let height: number; //Height of the region (default to undefined)
let showCursor: boolean; //Whether to show cursor in screenshot (optional) (default to undefined)

const { status, data } = await apiInstance.takeRegionScreenshot(
    x,
    y,
    width,
    height,
    showCursor
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **x** | [**number**] | X coordinate of the region | defaults to undefined|
| **y** | [**number**] | Y coordinate of the region | defaults to undefined|
| **width** | [**number**] | Width of the region | defaults to undefined|
| **height** | [**number**] | Height of the region | defaults to undefined|
| **showCursor** | [**boolean**] | Whether to show cursor in screenshot | (optional) defaults to undefined|


### Return type

**ScreenshotResponse**

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

# **takeScreenshot**
> ScreenshotResponse takeScreenshot()

Take a screenshot of the entire screen

### Example

```typescript
import {
    ComputerUseApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let showCursor: boolean; //Whether to show cursor in screenshot (optional) (default to undefined)

const { status, data } = await apiInstance.takeScreenshot(
    showCursor
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **showCursor** | [**boolean**] | Whether to show cursor in screenshot | (optional) defaults to undefined|


### Return type

**ScreenshotResponse**

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

# **typeText**
> object typeText(request)

Type text with optional delay between keystrokes

### Example

```typescript
import {
    ComputerUseApi,
    Configuration,
    KeyboardTypeRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new ComputerUseApi(configuration);

let request: KeyboardTypeRequest; //Text typing request

const { status, data } = await apiInstance.typeText(
    request
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **request** | **KeyboardTypeRequest**| Text typing request | |


### Return type

**object**

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

