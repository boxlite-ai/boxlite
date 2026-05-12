// Bridge between Go-exported callbacks and the typed C callback pointers
// expected by the BoxLite C API. Each accessor returns the callback as the
// strongly-typed function-pointer typedef so cgo wrappers in any Go file in
// this package can pass `C.cbXxx()` directly into the SDK.

#include "boxlite.h"

// Forward declarations for the //export'd Go callbacks. The signatures must
// match the cbindgen-generated typedefs exactly; the casts in the accessor
// bodies validate that at compile time.
extern void goBoxliteOnStdout(uint8_t const *data, size_t len, void *ud);
extern void goBoxliteOnStderr(uint8_t const *data, size_t len, void *ud);
extern void goBoxliteOnExit(int exit_code, void *ud);

extern void goBoxliteOnCreateBox(CBoxHandle *box, CBoxliteError *err, void *ud);
extern void goBoxliteOnGetBox(CBoxHandle *box, CBoxliteError *err, void *ud);
extern void goBoxliteOnStartBox(CBoxliteError *err, void *ud);
extern void goBoxliteOnStopBox(CBoxliteError *err, void *ud);
extern void goBoxliteOnRemoveBox(CBoxliteError *err, void *ud);
extern void goBoxliteOnCopy(CBoxliteError *err, void *ud);

extern void goBoxliteOnImagePull(CImagePullResult *res, CBoxliteError *err, void *ud);
extern void goBoxliteOnImageList(CImageInfoList *list, CBoxliteError *err, void *ud);

extern void goBoxliteOnInfo(CBoxInfo *info, CBoxliteError *err, void *ud);
extern void goBoxliteOnInfoList(CBoxInfoList *list, CBoxliteError *err, void *ud);

extern void goBoxliteOnBoxMetrics(CBoxMetrics *m, CBoxliteError *err, void *ud);
extern void goBoxliteOnRuntimeMetrics(CRuntimeMetrics *m, CBoxliteError *err, void *ud);

extern void goBoxliteOnRuntimeShutdown(CBoxliteError *err, void *ud);

extern void goBoxliteOnExecutionWait(int exit_code, CBoxliteError *err, void *ud);
extern void goBoxliteOnExecutionKill(CBoxliteError *err, void *ud);
extern void goBoxliteOnExecutionSignal(CBoxliteError *err, void *ud);
extern void goBoxliteOnExecutionResize(CBoxliteError *err, void *ud);

CBoxStdoutCb cbStdout(void) { return (CBoxStdoutCb)goBoxliteOnStdout; }
CBoxStderrCb cbStderr(void) { return (CBoxStderrCb)goBoxliteOnStderr; }
CBoxExitCb cbExit(void) { return (CBoxExitCb)goBoxliteOnExit; }

CBoxCreateBoxCb cbCreateBox(void) { return (CBoxCreateBoxCb)goBoxliteOnCreateBox; }
CBoxGetBoxCb cbGetBox(void) { return (CBoxGetBoxCb)goBoxliteOnGetBox; }
CBoxStartBoxCb cbStartBox(void) { return (CBoxStartBoxCb)goBoxliteOnStartBox; }
CBoxStopBoxCb cbStopBox(void) { return (CBoxStopBoxCb)goBoxliteOnStopBox; }
CBoxRemoveBoxCb cbRemoveBox(void) { return (CBoxRemoveBoxCb)goBoxliteOnRemoveBox; }
CBoxCopyCb cbCopy(void) { return (CBoxCopyCb)goBoxliteOnCopy; }

CBoxImagePullCb cbImagePull(void) { return (CBoxImagePullCb)goBoxliteOnImagePull; }
CBoxImageListCb cbImageList(void) { return (CBoxImageListCb)goBoxliteOnImageList; }

CBoxInfoCb cbInfo(void) { return (CBoxInfoCb)goBoxliteOnInfo; }
CBoxInfoListCb cbInfoList(void) { return (CBoxInfoListCb)goBoxliteOnInfoList; }

CBoxMetricsCb cbBoxMetrics(void) { return (CBoxMetricsCb)goBoxliteOnBoxMetrics; }
CRuntimeMetricsCb cbRuntimeMetrics(void) { return (CRuntimeMetricsCb)goBoxliteOnRuntimeMetrics; }

CRuntimeShutdownCb cbRuntimeShutdown(void) { return (CRuntimeShutdownCb)goBoxliteOnRuntimeShutdown; }

CExecutionWaitCb cbExecutionWait(void) { return (CExecutionWaitCb)goBoxliteOnExecutionWait; }
CExecutionKillCb cbExecutionKill(void) { return (CExecutionKillCb)goBoxliteOnExecutionKill; }
CExecutionSignalCb cbExecutionSignal(void) { return (CExecutionSignalCb)goBoxliteOnExecutionSignal; }
CExecutionResizeCb cbExecutionResize(void) { return (CExecutionResizeCb)goBoxliteOnExecutionResize; }
